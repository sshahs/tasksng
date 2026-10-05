//! TasksNG as a self-hosted web app: serves the same UI as the desktop app
//! and does the syncing with Baikal on the server, per signed-in account.
//!
//! Configuration is read from environment variables (see `Config::from_env`).

pub mod api;
pub mod state;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

pub use crate::state::AppState;

pub struct Config {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// The one CalDAV server people sign in to (recommended).
    pub caldav_url: Option<String>,
    /// Lets people enter any server address. Off by default: the server
    /// would connect wherever it is told to.
    pub allow_any_server: bool,
    /// `Secure` cookies; by default only when the request came over HTTPS
    /// (`X-Forwarded-Proto: https` from a reverse proxy).
    pub secure_cookie: Option<bool>,
}

fn env_flag(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let listen = var("TASKSNG_LISTEN").unwrap_or_else(|| "0.0.0.0:8080".into());
        Ok(Config {
            listen: listen.parse().map_err(|e| format!("TASKSNG_LISTEN={listen}: {e}"))?,
            data_dir: var("TASKSNG_DATA_DIR").unwrap_or_else(|| "/data".into()).into(),
            static_dir: var("TASKSNG_STATIC_DIR").unwrap_or_else(|| "/app/dist".into()).into(),
            caldav_url: var("TASKSNG_CALDAV_URL"),
            allow_any_server: env_flag("TASKSNG_ALLOW_ANY_SERVER").unwrap_or(false),
            secure_cookie: env_flag("TASKSNG_SECURE_COOKIE"),
        })
    }
}

/// Live updates for the signed-in account's tabs (Server-Sent Events).
async fn events(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(user) = api::current_user(&state, &headers) else {
        // 204 tells the browser not to reconnect; signing in opens a new stream.
        return StatusCode::NO_CONTENT.into_response();
    };
    let rx = user.events.subscribe();
    // Start with the current state, so a tab that reconnects (e.g. after a
    // server restart) is up to date.
    let first = [
        SseEvent::default().event("snapshot").data(serde_json::to_string(&user.store().snapshot()).unwrap_or_default()),
        SseEvent::default().event("sync-status").data(serde_json::to_string(&user.status()).unwrap_or_default()),
    ];
    let live = BroadcastStream::new(rx).filter_map(|e| e.ok()).map(|e| SseEvent::default().event(e.name).data(e.data));
    let stream: std::pin::Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>> =
        Box::pin(tokio_stream::iter(first).chain(live).map(Ok));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20))).into_response()
}

async fn health() -> &'static str {
    "ok"
}

/// The Content-Security-Policy for the UI. index.html has one small inline
/// script (applying the theme before the first paint); it is allowed by its
/// hash, like Tauri does in the desktop app.
fn content_security_policy(index_html: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let mut hashes = String::new();
    let mut rest = index_html;
    while let Some(start) = rest.find("<script>") {
        let after = &rest[start + "<script>".len()..];
        let Some(end) = after.find("</script>") else { break };
        let digest = Sha256::digest(&after.as_bytes()[..end]);
        hashes.push_str(&format!(" 'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(digest)));
        rest = &after[end..];
    }
    format!(
        "default-src 'self'; script-src 'self'{hashes}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
         font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
}

pub fn app(state: Arc<AppState>) -> Router {
    let index = state.config.static_dir.join("index.html");
    let csp = content_security_policy(&std::fs::read_to_string(&index).unwrap_or_default());
    let csp = HeaderValue::from_str(&csp).unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'"));
    let files = ServeDir::new(&state.config.static_dir).fallback(ServeFile::new(index));
    let api = Router::new()
        .route("/events", get(events))
        .route("/{cmd}", post(api::command))
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")));
    Router::new()
        .route("/healthz", get(health))
        .nest("/api", api)
        .fallback_service(files)
        .with_state(state)
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, csp))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn csp_allows_the_inline_theme_script_by_hash() {
        let csp = super::content_security_policy("<head><script>a()</script><script type=\"module\" src=\"/x.js\"></script>");
        assert!(csp.contains("script-src 'self' 'sha256-qVpDBgj7bpq5hMAcGp3AOc79J3Y1Z4HvySTwKrWDoy4=';"), "{csp}");
        assert_eq!(csp.matches("'sha256-").count(), 1);
    }
}
