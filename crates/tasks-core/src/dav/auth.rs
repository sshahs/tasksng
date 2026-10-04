//! HTTP Basic and Digest (RFC 7616) authentication.
//!
//! Baikal lets the administrator choose between Basic and Digest; Digest is
//! the default on many installations, and reqwest does not implement it.

use base64::Engine as _;
use md5::Md5;
use sha2::{Digest as _, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestChallenge {
    pub realm: String,
    pub nonce: String,
    pub opaque: Option<String>,
    /// `Some("auth")` when the server offers quality of protection.
    pub qop: Option<String>,
    pub algorithm: String,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scheme {
    Basic,
    Digest(DigestChallenge),
}

/// Parses the `WWW-Authenticate` header values of a 401 response and picks
/// the strongest scheme we support.
pub fn pick_scheme<'a>(headers: impl IntoIterator<Item = &'a str>) -> Option<Scheme> {
    let mut basic = false;
    let mut digests = Vec::new();
    for value in headers {
        for (scheme, params) in parse_challenges(value) {
            if scheme.eq_ignore_ascii_case("basic") {
                basic = true;
            } else if scheme.eq_ignore_ascii_case("digest") {
                let get = |k: &str| params.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone());
                let Some(nonce) = get("nonce") else { continue };
                let algorithm = get("algorithm").unwrap_or_else(|| "MD5".into()).to_ascii_uppercase();
                if !matches!(algorithm.as_str(), "MD5" | "MD5-SESS" | "SHA-256" | "SHA-256-SESS") {
                    continue;
                }
                let qop = get("qop").and_then(|q| {
                    q.split(',').map(str::trim).find(|q| q.eq_ignore_ascii_case("auth")).map(|_| "auth".to_string())
                });
                digests.push(DigestChallenge {
                    realm: get("realm").unwrap_or_default(),
                    nonce,
                    opaque: get("opaque"),
                    qop,
                    algorithm,
                    stale: get("stale").is_some_and(|s| s.eq_ignore_ascii_case("true")),
                });
            }
        }
    }
    digests.sort_by_key(|d| if d.algorithm.starts_with("SHA-256") { 0 } else { 1 });
    if let Some(d) = digests.into_iter().next() {
        return Some(Scheme::Digest(d));
    }
    basic.then_some(Scheme::Basic)
}

type Challenge = (String, Vec<(String, String)>);

/// Splits a header value such as
/// `Basic realm="x", Digest realm="y", nonce="z"` into challenges.
fn parse_challenges(value: &str) -> Vec<Challenge> {
    let mut out: Vec<Challenge> = Vec::new();
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    let skip_ws = |i: &mut usize| {
        while *i < chars.len() && (chars[*i].is_whitespace() || chars[*i] == ',') {
            *i += 1;
        }
    };
    loop {
        skip_ws(&mut i);
        if i >= chars.len() {
            break;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' && chars[i] != ',' {
            i += 1;
        }
        let token: String = chars[start..i].iter().collect();
        let mut j = i;
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        if j < chars.len() && chars[j] == '=' {
            // auth-param of the current challenge
            i = j + 1;
            while i < chars.len() && chars[i] == ' ' {
                i += 1;
            }
            let mut val = String::new();
            if i < chars.len() && chars[i] == '"' {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    val.push(chars[i]);
                    i += 1;
                }
                i += 1;
            } else {
                while i < chars.len() && chars[i] != ',' {
                    val.push(chars[i]);
                    i += 1;
                }
            }
            if let Some(last) = out.last_mut() {
                last.1.push((token, val.trim().to_string()));
            }
        } else {
            out.push((token, Vec::new()));
        }
    }
    out
}

pub fn basic_header(user: &str, pass: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")))
}

fn hash(algorithm: &str, data: &str) -> String {
    if algorithm.starts_with("SHA-256") {
        hex(&Sha256::digest(data.as_bytes()))
    } else {
        hex(&Md5::digest(data.as_bytes()))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn digest_header(
    ch: &DigestChallenge,
    nc: u32,
    cnonce: &str,
    user: &str,
    pass: &str,
    method: &str,
    uri: &str,
) -> String {
    let alg = ch.algorithm.as_str();
    let mut ha1 = hash(alg, &format!("{user}:{}:{pass}", ch.realm));
    if alg.ends_with("-SESS") {
        ha1 = hash(alg, &format!("{ha1}:{}:{cnonce}", ch.nonce));
    }
    let ha2 = hash(alg, &format!("{method}:{uri}"));
    let nc_str = format!("{nc:08x}");
    let response = match &ch.qop {
        Some(qop) => hash(alg, &format!("{ha1}:{}:{nc_str}:{cnonce}:{qop}:{ha2}", ch.nonce)),
        None => hash(alg, &format!("{ha1}:{}:{ha2}", ch.nonce)),
    };
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut h = format!(
        "Digest username=\"{}\", realm=\"{}\", nonce=\"{}\", uri=\"{}\", algorithm={}, response=\"{}\"",
        q(user),
        q(&ch.realm),
        q(&ch.nonce),
        q(uri),
        ch.algorithm,
        response
    );
    if let Some(qop) = &ch.qop {
        h.push_str(&format!(", qop={qop}, nc={nc_str}, cnonce=\"{cnonce}\""));
    }
    if let Some(opaque) = &ch.opaque {
        h.push_str(&format!(", opaque=\"{}\"", q(opaque)));
    }
    h
}

pub fn new_cnonce() -> String {
    let bytes: [u8; 12] = rand::random();
    hex(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_digest_over_basic() {
        let s = pick_scheme([
            "Basic realm=\"BaikalDAV\", charset=\"UTF-8\"",
            "Digest realm=\"BaikalDAV\",qop=\"auth\",nonce=\"5f1a\",opaque=\"abcd\"",
        ])
        .unwrap();
        match s {
            Scheme::Digest(d) => {
                assert_eq!(d.realm, "BaikalDAV");
                assert_eq!(d.nonce, "5f1a");
                assert_eq!(d.opaque.as_deref(), Some("abcd"));
                assert_eq!(d.qop.as_deref(), Some("auth"));
                assert_eq!(d.algorithm, "MD5");
            }
            _ => panic!("expected digest"),
        }
        assert_eq!(pick_scheme(["Basic realm=\"x\""]), Some(Scheme::Basic));
        assert_eq!(pick_scheme(["Bearer realm=\"x\""]), None);
    }

    #[test]
    fn multiple_challenges_in_one_header() {
        let s = pick_scheme(["Basic realm=\"a\", Digest realm=\"b\", nonce=\"n\", qop=\"auth,auth-int\""]).unwrap();
        assert!(matches!(s, Scheme::Digest(ref d) if d.realm == "b" && d.qop.as_deref() == Some("auth")));
    }

    #[test]
    fn rfc2617_example() {
        // Example from RFC 2617 section 3.5.
        let ch = DigestChallenge {
            realm: "testrealm@host.com".into(),
            nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093".into(),
            opaque: Some("5ccc069c403ebaf9f0171e9517f40e41".into()),
            qop: Some("auth".into()),
            algorithm: "MD5".into(),
            stale: false,
        };
        let h = digest_header(&ch, 1, "0a4f113b", "Mufasa", "Circle Of Life", "GET", "/dir/index.html");
        assert!(h.contains("response=\"6629fae49393a05397450978507c4ef1\""), "{h}");
        assert!(h.contains("nc=00000001"));
    }
}
