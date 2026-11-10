//! Pairing phones with this server.
//!
//! A signed-in browser shows a short code (as a QR code); the TasksNG app on
//! a phone scans it and is told which account to sign in to. From then on
//! the phone is a *linked device*: it holds a token with which it tells the
//! server when it changed something (so open tabs refresh at once), listens
//! for changes made in a browser, and can sign in other browsers.
//!
//! The other way round, the sign-in page shows a code that a phone approves:
//! with its token if it is linked already, otherwise with its own account.
//!
//! Codes are single use and live for five minutes. Only hashes of device
//! tokens are stored.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use crate::api::{self, args, ok, ApiError, ApiResult, ConnectArgs};
use crate::state::{write_private, AppState, User};

const CODE_TTL_SECS: i64 = 300;
/// Without letters and digits that look alike (0/O, 1/I).
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PENDING: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    user: String,
    name: String,
    platform: String,
    paired_at: DateTime<Utc>,
    last_seen: DateTime<Utc>,
}

/// A device as the browser's settings show it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    platform: String,
    paired_at: DateTime<Utc>,
    last_seen: DateTime<Utc>,
}

enum Pending {
    /// Shown by a signed-in browser: links a phone to this account.
    Pair { user: String },
    /// Shown by the sign-in page: `user` is set once a phone approved.
    Login { secret: String, user: Option<String> },
}

#[derive(Default)]
struct Inner {
    /// Token hash → device.
    devices: HashMap<String, Device>,
    pending: HashMap<String, (Pending, DateTime<Utc>)>,
}

pub struct Pairing {
    path: PathBuf,
    inner: Mutex<Inner>,
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_code() -> String {
    let mut bytes = [0u8; 8];
    rand::fill(&mut bytes);
    bytes.iter().map(|b| ALPHABET[(b % 32) as usize] as char).collect()
}

/// `abcd-efgh` → `ABCDEFGH`.
fn normalize(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

/// Compares without telling how much matched through timing.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Pairing {
    pub fn open(path: PathBuf) -> Pairing {
        let devices = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Pairing { path, inner: Mutex::new(Inner { devices, pending: HashMap::new() }) }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, inner: &Inner) {
        match serde_json::to_vec(&inner.devices) {
            Ok(bytes) => {
                if let Err(e) = write_private(&self.path, &bytes) {
                    log::error!("saving paired devices failed: {e}");
                }
            }
            Err(e) => log::error!("serializing paired devices failed: {e}"),
        }
    }

    fn add_pending(&self, pending: Pending) -> String {
        let mut inner = self.lock();
        let now = Utc::now();
        inner.pending.retain(|_, (_, expires)| *expires > now);
        // Someone asking for codes in a loop must not fill the memory.
        if inner.pending.len() >= MAX_PENDING {
            if let Some(oldest) = inner.pending.iter().min_by_key(|(_, (_, e))| *e).map(|(k, _)| k.clone()) {
                inner.pending.remove(&oldest);
            }
        }
        let code = loop {
            let code = random_code();
            if !inner.pending.contains_key(&code) {
                break code;
            }
        };
        inner.pending.insert(code.clone(), (pending, now + chrono::Duration::seconds(CODE_TTL_SECS)));
        code
    }

    fn register(&self, user: &str, name: &str, platform: &str) -> (String, String) {
        let token = random_token();
        let id = hash(&token)[..16].to_string();
        let now = Utc::now();
        let name: String = name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
        let device = Device {
            id: id.clone(),
            user: user.to_string(),
            name: if name.is_empty() { "Phone".into() } else { name },
            platform: platform.chars().filter(|c| c.is_ascii_alphanumeric()).take(20).collect(),
            paired_at: now,
            last_seen: now,
        };
        let mut inner = self.lock();
        inner.devices.insert(hash(&token), device);
        self.save(&inner);
        (id, token)
    }

    /// The device and account a token belongs to.
    fn device(&self, token: &str) -> Option<(String, String)> {
        let mut inner = self.lock();
        let device = inner.devices.get_mut(&hash(token))?;
        device.last_seen = Utc::now();
        Some((device.id.clone(), device.user.clone()))
    }

    pub fn devices_of(&self, user: &str) -> Vec<DeviceView> {
        let inner = self.lock();
        let mut out: Vec<DeviceView> = inner
            .devices
            .values()
            .filter(|d| d.user == user)
            .map(|d| DeviceView { id: d.id.clone(), name: d.name.clone(), platform: d.platform.clone(), paired_at: d.paired_at, last_seen: d.last_seen })
            .collect();
        out.sort_by(|a, b| b.paired_at.cmp(&a.paired_at));
        out
    }

    fn remove(&self, user: &str, id: &str) -> bool {
        let mut inner = self.lock();
        let before = inner.devices.len();
        inner.devices.retain(|_, d| !(d.user == user && d.id == id));
        let removed = inner.devices.len() != before;
        if removed {
            self.save(&inner);
        }
        removed
    }

    /// Forgets all devices of an account (it signed out). Answers their ids.
    pub fn remove_user(&self, user: &str) -> Vec<String> {
        let mut inner = self.lock();
        let ids: Vec<String> = inner.devices.values().filter(|d| d.user == user).map(|d| d.id.clone()).collect();
        if !ids.is_empty() {
            inner.devices.retain(|_, d| d.user != user);
            self.save(&inner);
        }
        ids
    }
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value.strip_prefix("Bearer ").map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// The linked device (and its account) a request comes from.
fn device_of(state: &AppState, headers: &HeaderMap) -> Result<(String, Arc<User>), ApiError> {
    let unknown = || ApiError(StatusCode::UNAUTHORIZED, "This phone is no longer paired with the web app".into());
    let token = bearer(headers).ok_or_else(unknown)?;
    let (id, user) = state.pairing.device(&token).ok_or_else(unknown)?;
    let user = state.user(&user).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((id, user))
}

/// Requests from the app carry this header, like the browser's (see `api::command`).
fn check_header(headers: &HeaderMap) -> Result<(), ApiError> {
    if headers.get("x-tasksng").is_none() {
        return Err(ApiError(StatusCode::FORBIDDEN, "Missing X-TasksNG header".into()));
    }
    Ok(())
}

async fn wrong_code() -> ApiError {
    // Slow down guessing.
    tokio::time::sleep(Duration::from_millis(700)).await;
    ApiError::bad("That code isn't valid any more. Show a new one in the web app and try again.")
}

// ---------------------------------------------------------------------------
// From the browser

/// A code that links a phone to the signed-in account.
pub fn pair_start(state: &AppState, user: &User) -> ApiResult {
    if user.connection().is_none() {
        return Err(ApiError::bad("Sign in again first"));
    }
    let code = state.pairing.add_pending(Pending::Pair { user: user.id.clone() });
    ok(json!({ "code": code, "expiresIn": CODE_TTL_SECS }))
}

/// A code on the sign-in page, for a phone to approve.
pub fn login_start(state: &AppState) -> ApiResult {
    let secret = random_token();
    let code = state.pairing.add_pending(Pending::Login { secret: secret.clone(), user: None });
    ok(json!({ "code": code, "secret": secret, "expiresIn": CODE_TTL_SECS }))
}

/// Asked by the sign-in page until a phone has approved its code.
pub async fn login_poll(state: &Arc<AppState>, headers: &HeaderMap, body: &Value) -> ApiResult {
    #[derive(Deserialize)]
    struct A {
        code: String,
        secret: String,
    }
    let a: A = args(body)?;
    let code = normalize(&a.code);
    let approved = {
        let mut inner = state.pairing.lock();
        let now = Utc::now();
        match inner.pending.get(&code) {
            Some((Pending::Login { secret, user }, expires)) if *expires > now && same(secret, &a.secret) => match user.clone() {
                Some(user) => {
                    inner.pending.remove(&code);
                    Some(user)
                }
                None => return ok(json!({ "status": "pending" })),
            },
            _ => return ok(json!({ "status": "expired" })),
        }
    };
    let Some(id) = approved else { return ok(json!({ "status": "pending" })) };
    let user = state.user(&id).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if user.connection().is_none() {
        return ok(json!({ "status": "expired" }));
    }
    Ok(api::start_session(state, headers, &user).await)
}

pub fn unlink_device(state: &AppState, user: &User, body: &Value) -> ApiResult {
    #[derive(Deserialize)]
    struct A {
        id: String,
    }
    let a: A = args(body)?;
    if state.pairing.remove(&user.id, &a.id) {
        let _ = user.device_events.send(format!("unlinked:{}", a.id));
    }
    ok(state.pairing.devices_of(&user.id))
}

// ---------------------------------------------------------------------------
// From the phone

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimArgs {
    code: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    platform: String,
    /// The phone's own account, when it approves a sign-in without being linked yet.
    account: Option<ConnectArgs>,
}

fn respond(result: ApiResult) -> Response {
    let mut response = result.unwrap_or_else(|e| e.into_response());
    response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    response
}

/// The phone scanned a signed-in browser's code: link it and tell it the account.
pub async fn claim(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(a): Json<ClaimArgs>) -> Response {
    respond(claim_inner(&state, &headers, a).await)
}

async fn claim_inner(state: &Arc<AppState>, headers: &HeaderMap, a: ClaimArgs) -> ApiResult {
    check_header(headers)?;
    let code = normalize(&a.code);
    let user_id = {
        let mut inner = state.pairing.lock();
        let now = Utc::now();
        match inner.pending.get(&code) {
            Some((Pending::Pair { user }, expires)) if *expires > now => {
                let user = user.clone();
                inner.pending.remove(&code);
                Some(user)
            }
            _ => None,
        }
    };
    let Some(user_id) = user_id else { return Err(wrong_code().await) };
    let user = state.user(&user_id).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let account = user.store().account().cloned();
    let (Some(account), Some(password)) = (account, user.password()) else {
        return Err(ApiError::bad("The web app is signed out. Sign in there again and show a new code."));
    };
    let (device_id, token) = state.pairing.register(&user.id, &a.device_name, &a.platform);
    log::info!("account {} paired a device", user.id);
    user.emit("devices", &state.pairing.devices_of(&user.id));
    ok(json!({
        "deviceId": device_id,
        "token": token,
        "account": {
            "serverUrl": account.server_url,
            "username": account.username,
            "password": password,
            "acceptInvalidCerts": account.accept_invalid_certs,
        },
    }))
}

/// The phone approves the code a sign-in page shows.
pub async fn approve(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(a): Json<ClaimArgs>) -> Response {
    respond(approve_inner(&state, &headers, a).await)
}

async fn approve_inner(state: &Arc<AppState>, headers: &HeaderMap, a: ClaimArgs) -> ApiResult {
    check_header(headers)?;
    let code = normalize(&a.code);
    let known = {
        let inner = state.pairing.lock();
        matches!(inner.pending.get(&code), Some((Pending::Login { user: None, .. }, expires)) if *expires > Utc::now())
    };
    if !known {
        return Err(wrong_code().await);
    }
    // A linked phone is known by its token; any other proves itself with its account.
    let (user, linked) = if bearer(headers).is_some() {
        (device_of(state, headers)?.1, None)
    } else {
        let Some(account) = &a.account else { return Err(ApiError::bad("Pair this phone with the web app first")) };
        let user = api::sign_in(state, account).await?;
        let linked = state.pairing.register(&user.id, &a.device_name, &a.platform);
        user.emit("devices", &state.pairing.devices_of(&user.id));
        (user, Some(linked))
    };
    if user.connection().is_none() {
        return Err(ApiError::bad("The web app has no connection for this account. Sign in there with your password."));
    }
    {
        let mut inner = state.pairing.lock();
        match inner.pending.get_mut(&code) {
            Some((Pending::Login { user: slot @ None, .. }, _)) => *slot = Some(user.id.clone()),
            _ => return Err(ApiError::bad("That code isn't valid any more.")),
        }
    }
    log::info!("account {} signed a browser in from a phone", user.id);
    match linked {
        Some((device_id, token)) => ok(json!({ "deviceId": device_id, "token": token })),
        None => ok(json!({})),
    }
}

/// The phone changed something on the CalDAV server: sync now, so open tabs show it.
pub async fn poke(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let user = match check_header(&headers).and_then(|_| device_of(&state, &headers)) {
        Ok((_, user)) => user,
        Err(e) => return e.into_response(),
    };
    tokio::spawn(async move {
        let _ = api::run_sync(&user).await;
    });
    respond(ok(json!({})))
}

pub async fn unlink(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    match check_header(&headers).and_then(|_| device_of(&state, &headers)) {
        Ok((id, user)) => {
            state.pairing.remove(&user.id, &id);
            user.emit("devices", &state.pairing.devices_of(&user.id));
            respond(ok(json!({})))
        }
        Err(e) => e.into_response(),
    }
}

/// Live updates for a linked phone: `changed` after a browser changed
/// something, `unlinked` when the phone was removed.
pub async fn device_events(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let (id, user) = match device_of(&state, &headers) {
        Ok(found) => found,
        Err(e) => return e.into_response(),
    };
    let unlinked = format!("unlinked:{id}");
    let live = BroadcastStream::new(user.device_events.subscribe()).filter_map(|e| e.ok()).filter_map(move |e| {
        if e == "changed" {
            Some(SseEvent::default().event("changed").data("{}"))
        } else if e == unlinked {
            Some(SseEvent::default().event("unlinked").data("{}"))
        } else {
            None
        }
    });
    let hello = tokio_stream::iter([SseEvent::default().event("hello").data("{}")]);
    let stream: std::pin::Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>> = Box::pin(hello.chain(live).map(Ok));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_readable_and_forgiving() {
        let code = random_code();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|b| ALPHABET.contains(&b)));
        assert_eq!(normalize("abcd-efgh "), "ABCDEFGH");
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }

    #[test]
    fn devices_are_stored_by_token_hash_and_removed_per_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let pairing = Pairing::open(path.clone());
        let (id, token) = pairing.register("alice", "  Pixel 9\n", "android");
        let (_, other) = pairing.register("bob", "", "android");
        assert_eq!(pairing.device(&token), Some((id.clone(), "alice".to_string())));
        assert_eq!(pairing.device("nope"), None);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&token));
        let devices = pairing.devices_of("alice");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Pixel 9");
        assert_eq!(pairing.devices_of("bob")[0].name, "Phone");
        // Reloaded from disk.
        let again = Pairing::open(path);
        assert!(again.device(&token).is_some());
        assert!(!again.remove("bob", &id));
        assert!(again.remove("alice", &id));
        assert_eq!(again.device(&token), None);
        assert_eq!(again.remove_user("bob").len(), 1);
        assert_eq!(again.device(&other), None);
    }

    #[test]
    fn codes_expire_and_are_single_use() {
        let dir = tempfile::tempdir().unwrap();
        let pairing = Pairing::open(dir.path().join("devices.json"));
        let code = pairing.add_pending(Pending::Pair { user: "alice".into() });
        {
            let mut inner = pairing.lock();
            assert!(inner.pending.contains_key(&code));
            inner.pending.get_mut(&code).unwrap().1 = Utc::now() - chrono::Duration::seconds(1);
        }
        // Asking for another code clears out the expired one.
        let next = pairing.add_pending(Pending::Login { secret: "s".into(), user: None });
        let inner = pairing.lock();
        assert!(!inner.pending.contains_key(&code));
        assert!(inner.pending.contains_key(&next));
    }
}
