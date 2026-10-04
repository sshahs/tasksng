//! CalDAV client tuned for Baikal / sabre/dav servers.

pub mod auth;
pub mod xml;

use std::sync::Mutex;
use std::time::Duration;

use reqwest::header::{HeaderMap, AUTHORIZATION, CONTENT_TYPE, ETAG, LOCATION, WWW_AUTHENTICATE};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

use self::auth::Scheme;
use self::xml::{escape, DavResponse, CALDAV, CS, DAV, ICAL};
use crate::Error;

const USER_AGENT: &str = concat!("TasksNG/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: String,
    pub url: Url,
}

impl Response {
    fn etag(&self) -> Option<String> {
        self.headers.get(ETAG).and_then(|v| v.to_str().ok()).map(str::to_string)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub principal_url: String,
    pub home_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCalendar {
    pub href: String,
    pub name: String,
    pub color: Option<String>,
    pub order: Option<i64>,
    pub ctag: Option<String>,
    pub supports_todo: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone)]
pub struct RemoteObject {
    pub href: String,
    pub etag: Option<String>,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutCondition {
    /// Only create, fail if the resource exists.
    Create,
    /// Only overwrite this exact version.
    Update(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteResult {
    Ok { etag: Option<String> },
    /// Someone else changed (or created) the resource in the meantime.
    Conflict,
    /// The resource no longer exists.
    Gone,
}

#[derive(Default)]
struct AuthState {
    scheme: Option<Scheme>,
    nc: u32,
}

pub struct DavClient {
    http: reqwest::Client,
    creds: Credentials,
    host: String,
    auth: Mutex<AuthState>,
}

fn method(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).expect("valid method")
}

fn net_err(e: reqwest::Error) -> Error {
    log::debug!("request failed: {e:?}");
    // The innermost cause is the useful part ("Connection refused", "No such
    // host is known", certificate problems …); the outer layers repeat the URL.
    let mut root = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        root = s.to_string();
        src = s.source();
    }
    let lower = root.to_ascii_lowercase();
    if lower.contains("certificate") || lower.contains("handshake") || lower.contains("ssl") || lower.contains("tls") {
        return Error::Certificate(root);
    }
    if e.is_timeout() {
        Error::Network("the connection timed out".into())
    } else if e.is_connect() || e.is_request() {
        Error::Network(root)
    } else {
        Error::Protocol(root)
    }
}

/// Accepts `dav.example.com`, `https://example.com/baikal/html/` … and turns
/// it into a URL with a trailing slash.
pub fn normalize_url(input: &str) -> Result<Url, Error> {
    let input = input.trim();
    if input.is_empty() {
        return Err(Error::InvalidInput("Enter the address of your Baikal server".into()));
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let mut url = Url::parse(&with_scheme).map_err(|e| Error::InvalidInput(format!("Invalid server address: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::InvalidInput("The server address must start with http:// or https://".into()));
    }
    url.set_fragment(None);
    url.set_query(None);
    if !url.path().ends_with('/') {
        let p = format!("{}/", url.path());
        url.set_path(&p);
    }
    Ok(url)
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let decoded = percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string();
        decoded.trim_end_matches('/').to_string()
    };
    norm(a) == norm(b)
}

/// Converts an href from a response into a path (hrefs may be absolute URLs).
fn href_path(href: &str) -> String {
    match Url::parse(href) {
        Ok(u) => u.path().to_string(),
        Err(_) => href.to_string(),
    }
}

impl DavClient {
    pub fn new(base: &Url, creds: Credentials, accept_invalid_certs: bool) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
            .tls_danger_accept_invalid_certs(accept_invalid_certs)
            .build()
            .map_err(|e| Error::Other(format!("Could not create HTTP client: {e}")))?;
        Ok(DavClient {
            http,
            creds,
            host: base.host_str().unwrap_or_default().to_ascii_lowercase(),
            auth: Mutex::new(AuthState::default()),
        })
    }

    fn may_send_credentials(&self, url: &Url) -> bool {
        url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(&self.host))
    }

    fn auth_header(&self, method: &Method, url: &Url) -> Option<String> {
        if !self.may_send_credentials(url) {
            return None;
        }
        let mut st = self.auth.lock().expect("auth lock");
        match st.scheme.clone()? {
            Scheme::Basic => Some(auth::basic_header(&self.creds.username, &self.creds.password)),
            Scheme::Digest(ch) => {
                st.nc += 1;
                let mut uri = url.path().to_string();
                if let Some(q) = url.query() {
                    uri.push('?');
                    uri.push_str(q);
                }
                Some(auth::digest_header(
                    &ch,
                    st.nc,
                    &auth::new_cnonce(),
                    &self.creds.username,
                    &self.creds.password,
                    method.as_str(),
                    &uri,
                ))
            }
        }
    }

    /// Sends a request, handling authentication challenges and redirects
    /// (which must keep the WebDAV method, unlike browser semantics).
    pub async fn send(
        &self,
        method_name: &str,
        url: &Url,
        headers: &[(&str, String)],
        body: Option<(&str, String)>,
    ) -> Result<Response, Error> {
        let method = method(method_name);
        let mut url = url.clone();
        let mut auth_attempts = 0;
        for _ in 0..10 {
            let mut req = self.http.request(method.clone(), url.clone());
            for (k, v) in headers {
                req = req.header(*k, v.as_str());
            }
            if let Some(h) = self.auth_header(&method, &url) {
                req = req.header(AUTHORIZATION, h);
            }
            if let Some((ct, b)) = &body {
                req = req.header(CONTENT_TYPE, *ct).body(b.clone());
            }
            let resp = req.send().await.map_err(net_err)?;
            let status = resp.status();

            if status == StatusCode::UNAUTHORIZED {
                let values: Vec<String> = resp
                    .headers()
                    .get_all(WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|v| v.to_str().ok().map(str::to_string))
                    .collect();
                let scheme = auth::pick_scheme(values.iter().map(String::as_str));
                let Some(scheme) = scheme else { return Err(Error::Unauthorized) };
                let stale = matches!(&scheme, Scheme::Digest(d) if d.stale);
                // Retry once with a fresh challenge; a second rejection means
                // the credentials are wrong (unless the nonce merely expired).
                if !self.may_send_credentials(&url) || auth_attempts >= 2 || (auth_attempts >= 1 && !stale) {
                    return Err(Error::Unauthorized);
                }
                {
                    let mut st = self.auth.lock().expect("auth lock");
                    st.scheme = Some(scheme);
                    st.nc = 0;
                }
                auth_attempts += 1;
                continue;
            }

            if status.is_redirection() && status != StatusCode::NOT_MODIFIED {
                if let Some(loc) = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()) {
                    let next = url.join(loc).map_err(|e| Error::Protocol(format!("bad redirect: {e}")))?;
                    // Never follow a downgrade from https to http with credentials.
                    if url.scheme() == "https" && next.scheme() == "http" {
                        return Err(Error::Protocol("The server redirected to an insecure (http) address".into()));
                    }
                    url = next;
                    continue;
                }
            }

            let headers = resp.headers().clone();
            let final_url = resp.url().clone();
            let body = resp.text().await.map_err(net_err)?;
            return Ok(Response { status, headers, body, url: final_url });
        }
        Err(Error::Protocol("Too many redirects".into()))
    }

    async fn dav_xml(&self, method: &str, url: &Url, depth: &str, body: String) -> Result<Response, Error> {
        self.send(method, url, &[("Depth", depth.to_string())], Some(("application/xml; charset=utf-8", body))).await
    }

    async fn multistatus(&self, method: &str, url: &Url, depth: &str, body: String) -> Result<Vec<DavResponse>, Error> {
        let resp = self.dav_xml(method, url, depth, body).await?;
        if resp.status != StatusCode::MULTI_STATUS {
            return Err(http_error(&resp));
        }
        xml::parse_multistatus(&resp.body).map_err(Error::Protocol)
    }

    /// Finds the user's principal and calendar home starting from whatever
    /// address the user typed.
    pub async fn discover(&self, input: &Url) -> Result<(Url, Discovery), Error> {
        let mut candidates = vec![input.clone()];
        let push = |c: &mut Vec<Url>, u: Option<Url>| {
            if let Some(u) = u {
                if !c.contains(&u) {
                    c.push(u);
                }
            }
        };
        if !input.path().contains("dav.php") {
            push(&mut candidates, input.join("dav.php/").ok());
        }
        push(&mut candidates, input.join("/.well-known/caldav").ok());
        push(&mut candidates, input.join("/dav.php/").ok());
        push(&mut candidates, input.join("/baikal/html/dav.php/").ok());

        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/></d:prop>
</d:propfind>"#;

        let mut last_err = None;
        for (i, candidate) in candidates.iter().enumerate() {
            let resp = match self.dav_xml("PROPFIND", candidate, "0", body.to_string()).await {
                Ok(r) => r,
                Err(Error::Network(e)) if i == 0 => return Err(Error::Network(e)),
                Err(e @ (Error::Unauthorized | Error::Certificate(_))) => return Err(e),
                Err(e) => {
                    last_err = Some(e);
                    continue;
                }
            };
            if resp.status != StatusCode::MULTI_STATUS {
                continue;
            }
            let Ok(items) = xml::parse_multistatus(&resp.body) else { continue };
            let Some(first) = items.first() else { continue };
            let principal = first
                .prop(DAV, "current-user-principal")
                .and_then(|p| p.child(DAV, "href"))
                .map(|h| h.trimmed().to_string());
            let Some(principal) = principal else { continue };
            let principal_url = resp.url.join(&principal).map_err(|e| Error::Protocol(e.to_string()))?;
            let home = self.calendar_home(&principal_url).await?;
            let home_url = principal_url.join(&home).map_err(|e| Error::Protocol(e.to_string()))?;
            return Ok((
                home_url.clone(),
                Discovery { principal_url: principal_url.to_string(), home_url: home_url.to_string() },
            ));
        }
        Err(match last_err {
            Some(Error::Network(e)) => Error::Network(e),
            _ => Error::Discovery,
        })
    }

    async fn calendar_home(&self, principal: &Url) -> Result<String, Error> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>"#;
        let items = self.multistatus("PROPFIND", principal, "0", body.to_string()).await?;
        items
            .iter()
            .find_map(|r| r.prop(CALDAV, "calendar-home-set").and_then(|p| p.hrefs().into_iter().next()))
            .ok_or(Error::Discovery)
    }

    pub async fn list_calendars(&self, home: &Url) -> Result<Vec<RemoteCalendar>, Error> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <d:sync-token/>
    <c:supported-calendar-component-set/>
    <ic:calendar-color/>
    <ic:calendar-order/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>"#;
        let items = self.multistatus("PROPFIND", home, "1", body.to_string()).await?;
        let mut out = Vec::new();
        for r in items {
            let Some(rt) = r.prop(DAV, "resourcetype") else { continue };
            if rt.child(CALDAV, "calendar").is_none() {
                continue;
            }
            let href = href_path(&r.href);
            let supports_todo = match r.prop(CALDAV, "supported-calendar-component-set") {
                Some(set) => set
                    .children_named(CALDAV, "comp")
                    .any(|c| c.attr("name").is_some_and(|n| n.eq_ignore_ascii_case("VTODO"))),
                None => true,
            };
            let read_only = r.prop(DAV, "current-user-privilege-set").is_some_and(|set| {
                !set.children_named(DAV, "privilege").any(|p| {
                    p.child(DAV, "write").is_some() || p.child(DAV, "all").is_some() || p.child(DAV, "write-content").is_some()
                })
            });
            let name = r.prop_text(DAV, "displayname").unwrap_or_else(|| {
                href.trim_end_matches('/').rsplit('/').next().unwrap_or("Tasks").to_string()
            });
            let color = r.prop_text(ICAL, "calendar-color").map(|c| normalize_color(&c));
            out.push(RemoteCalendar {
                href,
                name,
                color,
                order: r.prop_text(ICAL, "calendar-order").and_then(|o| o.parse().ok()),
                ctag: r.prop_text(CS, "getctag").or_else(|| r.prop_text(DAV, "sync-token")),
                supports_todo,
                read_only,
            });
        }
        Ok(out)
    }

    /// Lists `href → etag` of every task in a calendar.
    pub async fn list_etags(&self, calendar: &Url) -> Result<Vec<(String, Option<String>)>, Error> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>"#;
        let items = self.multistatus("REPORT", calendar, "1", body.to_string()).await?;
        Ok(items
            .into_iter()
            .filter(|r| r.status.is_none_or(|s| (200..300).contains(&s)))
            .map(|r| (href_path(&r.href), r.prop_text(DAV, "getetag")))
            .filter(|(h, _)| !same_path(h, calendar.path()))
            .collect())
    }

    /// Fetches every task in a calendar in one request.
    pub async fn fetch_all(&self, calendar: &Url) -> Result<Vec<RemoteObject>, Error> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>"#;
        let items = self.multistatus("REPORT", calendar, "1", body.to_string()).await?;
        Ok(collect_objects(items))
    }

    pub async fn multiget(&self, calendar: &Url, hrefs: &[String]) -> Result<Vec<RemoteObject>, Error> {
        let mut out = Vec::new();
        for chunk in hrefs.chunks(100) {
            let mut body = String::from(
                r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
"#,
            );
            for h in chunk {
                body.push_str(&format!("  <d:href>{}</d:href>\n", escape(h)));
            }
            body.push_str("</c:calendar-multiget>");
            let items = self.multistatus("REPORT", calendar, "1", body).await?;
            out.extend(collect_objects(items));
        }
        Ok(out)
    }

    pub async fn put(&self, url: &Url, ics: &str, cond: &PutCondition) -> Result<WriteResult, Error> {
        let mut headers = Vec::new();
        match cond {
            PutCondition::Create => headers.push(("If-None-Match", "*".to_string())),
            PutCondition::Update(Some(etag)) => headers.push(("If-Match", etag.clone())),
            PutCondition::Update(None) => {}
        }
        let resp = self.send("PUT", url, &headers, Some(("text/calendar; charset=utf-8", ics.to_string()))).await?;
        match resp.status.as_u16() {
            200..=299 => Ok(WriteResult::Ok { etag: resp.etag() }),
            412 => Ok(WriteResult::Conflict),
            404 | 410 => Ok(WriteResult::Gone),
            _ => Err(http_error(&resp)),
        }
    }

    pub async fn delete(&self, url: &Url, etag: Option<&str>) -> Result<WriteResult, Error> {
        let headers: Vec<(&str, String)> = etag.map(|e| vec![("If-Match", e.to_string())]).unwrap_or_default();
        let resp = self.send("DELETE", url, &headers, None).await?;
        match resp.status.as_u16() {
            200..=299 => Ok(WriteResult::Ok { etag: None }),
            404 | 410 => Ok(WriteResult::Gone),
            412 => Ok(WriteResult::Conflict),
            _ => Err(http_error(&resp)),
        }
    }

    /// Creates a new calendar that only holds tasks.
    pub async fn make_calendar(&self, home: &Url, name: &str, color: Option<&str>) -> Result<String, Error> {
        let slug = uuid::Uuid::new_v4().to_string();
        let url = home.join(&format!("{slug}/")).map_err(|e| Error::Protocol(e.to_string()))?;
        let color_xml = color.map(|c| format!("<ic:calendar-color>{}</ic:calendar-color>", escape(&apple_color(c)))).unwrap_or_default();
        let body = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:set><d:prop>
    <d:displayname>{}</d:displayname>
    {color_xml}
    <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
  </d:prop></d:set>
</c:mkcalendar>"#,
            escape(name)
        );
        let resp = self.send("MKCALENDAR", &url, &[], Some(("application/xml; charset=utf-8", body))).await?;
        if resp.status != StatusCode::CREATED {
            return Err(http_error(&resp));
        }
        Ok(url.path().to_string())
    }

    pub async fn update_calendar(&self, url: &Url, name: Option<&str>, color: Option<&str>) -> Result<(), Error> {
        let mut props = String::new();
        if let Some(n) = name {
            props.push_str(&format!("<d:displayname>{}</d:displayname>", escape(n)));
        }
        if let Some(c) = color {
            props.push_str(&format!("<ic:calendar-color>{}</ic:calendar-color>", escape(&apple_color(c))));
        }
        if props.is_empty() {
            return Ok(());
        }
        let body = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:ic="http://apple.com/ns/ical/"><d:set><d:prop>{props}</d:prop></d:set></d:propertyupdate>"#
        );
        let resp = self.send("PROPPATCH", url, &[], Some(("application/xml; charset=utf-8", body))).await?;
        if resp.status != StatusCode::MULTI_STATUS && !resp.status.is_success() {
            return Err(http_error(&resp));
        }
        if resp.status == StatusCode::MULTI_STATUS && resp.body.contains(" 403 ") {
            return Err(Error::Http { status: 403, message: "The server refused to change this list".into() });
        }
        Ok(())
    }

    pub async fn delete_calendar(&self, url: &Url) -> Result<(), Error> {
        let resp = self.send("DELETE", url, &[], None).await?;
        if resp.status.is_success() || resp.status == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(http_error(&resp))
        }
    }
}

fn collect_objects(items: Vec<DavResponse>) -> Vec<RemoteObject> {
    items
        .into_iter()
        .filter_map(|r| {
            let data = r.prop(CALDAV, "calendar-data")?.text.clone();
            Some(RemoteObject { href: href_path(&r.href), etag: r.prop_text(DAV, "getetag"), data })
        })
        .collect()
}

/// Apple stores colors as `#RRGGBBAA`; the UI works with `#RRGGBB`.
pub fn normalize_color(c: &str) -> String {
    let c = c.trim();
    if c.len() == 9 && c.starts_with('#') {
        c[..7].to_ascii_uppercase()
    } else {
        c.to_ascii_uppercase()
    }
}

fn apple_color(c: &str) -> String {
    let c = c.trim();
    if c.len() == 7 && c.starts_with('#') {
        format!("{}FF", c.to_ascii_uppercase())
    } else {
        c.to_string()
    }
}

/// Builds a readable error from a failed response (sabre puts a
/// `<s:message>` in its error bodies).
fn http_error(resp: &Response) -> Error {
    let status = resp.status.as_u16();
    if status == 401 {
        return Error::Unauthorized;
    }
    let mut message = xml::parse(&resp.body)
        .ok()
        .and_then(|root| root.children.iter().find(|c| c.name == "message").map(|m| m.trimmed().to_string()))
        .unwrap_or_default();
    if message.is_empty() {
        message = resp.status.canonical_reason().unwrap_or("Unexpected response").to_string();
    }
    Error::Http { status, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("dav.example.com").unwrap().as_str(), "https://dav.example.com/");
        assert_eq!(
            normalize_url("http://host:8080/baikal/html/dav.php").unwrap().as_str(),
            "http://host:8080/baikal/html/dav.php/"
        );
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("  ").is_err());
    }

    #[test]
    fn colors() {
        assert_eq!(normalize_color("#ff8800ff"), "#FF8800");
        assert_eq!(apple_color("#ff8800"), "#FF8800FF");
    }

    #[test]
    fn path_compare() {
        assert!(same_path("/a/b%20c/", "/a/b c"));
        assert_eq!(href_path("https://x.org/dav.php/a.ics"), "/dav.php/a.ics");
    }
}
