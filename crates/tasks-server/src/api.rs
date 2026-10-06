//! The commands the UI sends (the same names and arguments as the desktop
//! app's Tauri commands), as `POST /api/<command>` with a JSON body.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tasks_core::dav::{normalize_url, Credentials, DavClient};
use tasks_core::model::{NewTask, PatchOutcome, Task, TaskPatch, TaskStatus};
use tasks_core::settings::{Settings, SettingsPatch};
use tasks_core::store::{write_atomic, Account, Resolution, Snapshot, Store, TaskList};
use tasks_core::sync::{self, SyncReport};
use tasks_core::Error;

use crate::state::{user_id, AppState, Connection, SyncStatus, User};

pub const COOKIE: &str = "tasksng_session";

/// An error for the UI: the message is shown as is.
pub struct ApiError(StatusCode, String);

impl ApiError {
    fn bad(msg: impl Into<String>) -> Self {
        ApiError(StatusCode::BAD_REQUEST, msg.into())
    }
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError::bad(e.to_string())
    }
}

impl From<String> for ApiError {
    fn from(e: String) -> Self {
        ApiError::bad(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

fn ok<T: Serialize>(value: T) -> ApiResult {
    Ok(Json(value).into_response())
}

fn args<T: DeserializeOwned>(body: &Value) -> Result<T, ApiError> {
    T::deserialize(body).map_err(|e| ApiError::bad(format!("Invalid request: {e}")))
}

pub fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

/// The signed-in account of this request, if any.
pub fn current_user(state: &AppState, headers: &HeaderMap) -> Option<Arc<User>> {
    let token = session_token(headers)?;
    let id = state.sessions().user_of(&token)?;
    state.user(&id).inspect_err(|e| log::error!("loading account {id} failed: {e}")).ok()
}

/// Whether the browser reached us over HTTPS (directly or via a proxy).
fn secure_request(state: &AppState, headers: &HeaderMap) -> bool {
    state.config.secure_cookie.unwrap_or_else(|| {
        headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).is_some_and(|p| p.eq_ignore_ascii_case("https"))
    })
}

fn cookie(state: &AppState, headers: &HeaderMap, value: &str, max_age: i64) -> HeaderValue {
    let secure = if secure_request(state, headers) { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"))
        .expect("cookie is ASCII")
}

// ---------------------------------------------------------------------------
// Background work (as in the desktop app)

pub fn emit_snapshot(user: &User) {
    let snapshot = user.store().snapshot();
    user.emit("snapshot", &snapshot);
}

pub fn set_status(user: &User, state: &'static str, message: Option<String>) {
    let (last_sync, pending) = {
        let store = user.store();
        (store.last_sync().map(str::to_string), store.pending_count())
    };
    let status = SyncStatus { state, message, last_sync, pending };
    *user.status.lock().unwrap_or_else(|p| p.into_inner()) = status.clone();
    user.emit("sync-status", &status);
}

fn status_for<T>(result: &Result<T, Error>) -> (&'static str, Option<String>) {
    match result {
        Ok(_) => ("idle", None),
        Err(Error::Unauthorized) => ("auth-required", Some(Error::Unauthorized.to_string())),
        Err(e) if e.is_offline() => ("offline", Some(e.to_string())),
        Err(e) => ("error", Some(e.to_string())),
    }
}

/// Persists the store shortly after changes (coalescing bursts of edits).
pub fn schedule_save(user: &Arc<User>) {
    if user.save_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let user = user.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        save_now(&user).await;
    });
}

pub async fn save_now(user: &User) {
    let _guard = user.save_lock.lock().await;
    user.save_pending.store(false, Ordering::SeqCst);
    let data = user.store().take_unsaved();
    if let Some((path, bytes)) = data {
        let res = tokio::task::spawn_blocking(move || write_atomic(&path, &bytes)).await;
        if let Ok(Err(e)) = res {
            log::error!("saving the cache of {} failed: {e}", user.id);
        }
    }
}

/// Sends local changes to the server shortly after they were made.
fn schedule_push(user: &Arc<User>) {
    if user.push_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let user = user.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        user.push_pending.store(false, Ordering::SeqCst);
        let Some(conn) = user.connection() else { return };
        let _guard = user.sync_lock.lock().await;
        let mut report = SyncReport::default();
        let result = sync::push(&user.store, &conn.client, &conn.home, &mut report).await;
        if let Err(e) = &result {
            log::info!("push failed: {e}");
        }
        let (s, msg) = status_for(&result);
        set_status(&user, s, msg);
        if !report.notices.is_empty() {
            user.emit("notices", &report.notices);
        }
        emit_snapshot(&user);
        schedule_save(&user);
    });
}

/// After a local edit: save, push, and let the account's other tabs know.
fn after_local_change(user: &Arc<User>) {
    schedule_save(user);
    schedule_push(user);
    emit_snapshot(user);
    let current = user.status();
    set_status(user, current.state, current.message);
}

async fn run_sync(user: &Arc<User>) -> Result<Vec<String>, Error> {
    let Some(conn) = user.connection() else {
        let msg = "Please sign in again".to_string();
        set_status(user, "auth-required", Some(msg.clone()));
        return Err(Error::Other(msg));
    };
    let _guard = user.sync_lock.lock().await;
    set_status(user, "syncing", None);
    let result = sync::sync(&user.store, &conn.client, &conn.home, &conn.home).await;
    let (s, msg) = status_for(&result);
    set_status(user, s, msg);
    emit_snapshot(user);
    schedule_save(user);
    result.map(|r| r.notices)
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    #[serde(default)]
    server_url: String,
    username: String,
    password: String,
    #[serde(default)]
    accept_invalid_certs: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOutcome {
    snapshot: Snapshot,
    notices: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskResult {
    task: Task,
    revision: u64,
    advanced_to: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResult {
    token: u64,
    snapshot: Snapshot,
}

#[derive(Debug, Deserialize)]
struct TaskUpdate {
    id: String,
    patch: TaskPatch,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    launch_at_login: bool,
    shortcut_error: Option<String>,
    native_notifications: bool,
    platform: Value,
}

fn settings_view(settings: Settings) -> SettingsView {
    SettingsView {
        settings,
        launch_at_login: false,
        shortcut_error: None,
        // Reminders reach the browser; it shows them (see the UI).
        native_notifications: false,
        platform: json!({
            "os": "web",
            "installKind": "server",
            "wayland": false,
            "tray": false,
            "notificationActions": false,
            "autostartError": null,
        }),
    }
}

/// What the sign-in screen needs to know before anyone is signed in.
fn server_info(state: &AppState) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "caldavUrl": state.config.caldav_url,
    })
}

pub async fn command(
    State(state): State<Arc<AppState>>,
    Path(cmd): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    // Every API call carries this header. Browsers don't let other sites
    // add it without a CORS preflight, which this server never allows.
    if headers.get("x-tasksng").is_none() {
        return ApiError(StatusCode::FORBIDDEN, "Missing X-TasksNG header".into()).into_response();
    }
    let body = body.map(|Json(v)| v).unwrap_or(Value::Null);
    let body = if body.is_null() { json!({}) } else { body };
    match dispatch(&state, &cmd, &headers, &body).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}

async fn dispatch(state: &Arc<AppState>, cmd: &str, headers: &HeaderMap, body: &Value) -> ApiResult {
    // Commands that work without signing in.
    match cmd {
        "server_info" => return ok(server_info(state)),
        "connect" => return connect(state, headers, args(&body["args"])?).await,
        _ => {}
    }
    let Some(user) = current_user(state, headers) else {
        return match cmd {
            "get_snapshot" => ok(Store::in_memory().snapshot()),
            "get_status" => ok(SyncStatus::signed_out()),
            "get_settings" => ok(settings_view(Settings::default())),
            "sign_out" => ok(Store::in_memory().snapshot()),
            _ => Err(ApiError(StatusCode::UNAUTHORIZED, "You are not signed in".into())),
        };
    };
    match cmd {
        "get_snapshot" => ok(user.store().snapshot()),
        "get_status" => ok(user.status()),
        "sign_out" => sign_out(state, headers, &user).await,
        "sync_now" => {
            let (notices, error) = match run_sync(&user).await {
                Ok(n) => (n, None),
                Err(e) => (Vec::new(), Some(e.to_string())),
            };
            ok(SyncOutcome { snapshot: user.store().snapshot(), notices, error })
        }
        "create_task" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                list_id: String,
                task: NewTask,
            }
            let a: A = args(body)?;
            let result = {
                let mut store = user.store();
                let task = store.create_task(&a.list_id, &a.task)?;
                TaskResult { task, revision: store.revision(), advanced_to: None }
            };
            after_local_change(&user);
            ok(result)
        }
        "update_task" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                patch: TaskPatch,
            }
            let a: A = args(body)?;
            let result = {
                let mut store = user.store();
                let (task, outcome) = store.update_task(&a.id, &a.patch)?;
                let advanced_to = match outcome {
                    PatchOutcome::Advanced { due } => Some(due),
                    PatchOutcome::Updated => None,
                };
                TaskResult { task, revision: store.revision(), advanced_to }
            };
            after_local_change(&user);
            ok(result)
        }
        "update_tasks" => {
            #[derive(Deserialize)]
            struct A {
                updates: Vec<TaskUpdate>,
            }
            let a: A = args(body)?;
            let snapshot = {
                let mut store = user.store();
                let updates: Vec<(String, TaskPatch)> = a.updates.into_iter().map(|u| (u.id, u.patch)).collect();
                store.update_tasks(&updates)?;
                store.snapshot()
            };
            after_local_change(&user);
            ok(snapshot)
        }
        "move_task" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                list_id: String,
            }
            let a: A = args(body)?;
            let snapshot = {
                let mut store = user.store();
                store.move_task(&a.id, &a.list_id)?;
                store.snapshot()
            };
            after_local_change(&user);
            ok(snapshot)
        }
        "delete_tasks" => {
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
            }
            let a: A = args(body)?;
            let result = {
                let mut store = user.store();
                let token = store.delete_tasks(&a.ids)?;
                DeleteResult { token, snapshot: store.snapshot() }
            };
            after_local_change(&user);
            ok(result)
        }
        "resolve_conflict" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                resolution: Resolution,
            }
            let a: A = args(body)?;
            let snapshot = {
                let mut store = user.store();
                store.resolve_conflict(&a.id, &a.resolution)?;
                store.snapshot()
            };
            after_local_change(&user);
            ok(snapshot)
        }
        "undo_delete" => {
            #[derive(Deserialize)]
            struct A {
                token: u64,
            }
            let a: A = args(body)?;
            let snapshot = {
                let mut store = user.store();
                store.undo_delete(a.token)?;
                store.snapshot()
            };
            after_local_change(&user);
            ok(snapshot)
        }
        "create_list" | "update_list" | "delete_list" => list_command(&user, cmd, body).await,
        "get_settings" => ok(settings_view(user.settings())),
        "update_settings" => {
            #[derive(Deserialize)]
            struct A {
                patch: SettingsPatch,
            }
            let a: A = args(body)?;
            let mut settings = user.settings();
            let was_on = settings.reminders;
            settings.apply(&a.patch);
            user.save_settings(&settings);
            if settings.reminders && !was_on {
                user.alarms.restart();
            }
            ok(settings_view(settings))
        }
        "reminder_action" => {
            #[derive(Deserialize)]
            struct A {
                uid: String,
                action: String,
                minutes: Option<u32>,
            }
            let a: A = args(body)?;
            match a.action.as_str() {
                "done" => {
                    let id = user.store().task_by_uid(&a.uid).filter(|t| !t.completed).map(|t| t.id.clone());
                    if let Some(id) = id {
                        let patch = TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() };
                        user.store().update_task(&id, &patch)?;
                        after_local_change(&user);
                    }
                }
                "snooze" => user.alarms.snooze(&a.uid, a.minutes.unwrap_or(10)),
                _ => {}
            }
            ok(Value::Null)
        }
        _ => Err(ApiError(StatusCode::NOT_FOUND, format!("Unknown command {cmd}"))),
    }
}

async fn connect(state: &Arc<AppState>, headers: &HeaderMap, a: ConnectArgs) -> ApiResult {
    let username = a.username.trim().to_string();
    if username.is_empty() {
        return Err(ApiError::bad("Enter your username"));
    }
    let server_url = match &state.config.caldav_url {
        Some(fixed) => fixed.clone(),
        None if state.config.allow_any_server => a.server_url.trim().to_string(),
        None => {
            return Err(ApiError::bad(
                "This TasksNG server has no CalDAV server configured. Set TASKSNG_CALDAV_URL (or TASKSNG_ALLOW_ANY_SERVER=true).",
            ))
        }
    };
    let input = normalize_url(&server_url)?;
    let creds = Credentials { username: username.clone(), password: a.password.clone() };
    let client = DavClient::new(&input, creds.clone(), a.accept_invalid_certs)?;
    let (home, discovery) = match client.discover(&input).await {
        Ok(found) => found,
        Err(e) => {
            if matches!(e, Error::Unauthorized) {
                // Slow down password guessing.
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            return Err(e.into());
        }
    };
    let client = if home.host_str() != input.host_str() {
        DavClient::new(&home, creds, a.accept_invalid_certs)?
    } else {
        client
    };

    let id = user_id(input.as_str(), &discovery.home_url, &username);
    let user = state.user(&id).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    user.save_password(&a.password).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not store the password: {e}")))?;
    user.store().set_account(Account {
        server_url,
        username,
        principal_url: discovery.principal_url,
        home_url: discovery.home_url,
        accept_invalid_certs: a.accept_invalid_certs,
    });
    user.set_connection(Some(Connection { client, home }));

    // A new session; a previous one in this browser (maybe another account) ends.
    let token = {
        let mut sessions = state.sessions();
        if let Some(old) = session_token(headers) {
            sessions.remove(&old);
        }
        sessions.create(&id)
    };
    log::info!("account {id} signed in");

    let (notices, error) = match run_sync(&user).await {
        Ok(n) => (n, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    let mut response = Json(SyncOutcome { snapshot: user.store().snapshot(), notices, error }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie(state, headers, &token, 90 * 24 * 3600));
    Ok(response)
}

async fn sign_out(state: &Arc<AppState>, headers: &HeaderMap, user: &Arc<User>) -> ApiResult {
    {
        let _guard = user.sync_lock.lock().await;
        user.set_connection(None);
        user.store().sign_out();
        user.forget_password();
    }
    state.sessions().remove_user(&user.id);
    set_status(user, "signed-out", None);
    save_now(user).await;
    log::info!("account {} signed out", user.id);
    let mut response = Json(user.store().snapshot()).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie(state, headers, "", 0));
    Ok(response)
}

fn online_err(e: Error) -> ApiError {
    if e.is_offline() {
        ApiError::bad("Lists can only be changed while connected to the server")
    } else {
        e.into()
    }
}

async fn list_command(user: &Arc<User>, cmd: &str, body: &Value) -> ApiResult {
    let conn = user.connection().ok_or_else(|| ApiError::bad("You are not signed in"))?;
    let list_url = |id: &str| conn.home.join(id).map_err(|e| ApiError::bad(e.to_string()));
    let _guard = user.sync_lock.lock().await;
    match cmd {
        "create_list" => {
            #[derive(Deserialize)]
            struct A {
                name: String,
                color: Option<String>,
            }
            let a: A = args(body)?;
            let name = a.name.trim().to_string();
            if name.is_empty() {
                return Err(ApiError::bad("Give the list a name"));
            }
            let href = conn.client.make_calendar(&conn.home, &name, a.color.as_deref()).await.map_err(online_err)?;
            user.store().add_list(TaskList { id: href, name, color: a.color, order: None, read_only: false, ctag: None });
        }
        "update_list" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                name: Option<String>,
                color: Option<String>,
            }
            let a: A = args(body)?;
            let name = a.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
            conn.client.update_calendar(&list_url(&a.id)?, name.as_deref(), a.color.as_deref()).await.map_err(online_err)?;
            user.store().rename_list(&a.id, name.as_deref(), a.color.as_deref());
        }
        _ => {
            #[derive(Deserialize)]
            struct A {
                id: String,
            }
            let a: A = args(body)?;
            conn.client.delete_calendar(&list_url(&a.id)?).await.map_err(online_err)?;
            user.store().remove_list(&a.id);
        }
    }
    emit_snapshot(user);
    schedule_save(user);
    ok(user.store().snapshot())
}

/// Checks every signed-in account with an open tab for due reminders.
pub fn check_reminders(state: &AppState) {
    for user in state.loaded_users() {
        if user.events.receiver_count() == 0 || user.connection().is_none() {
            // Nobody would see them; they are shown when a tab opens.
            continue;
        }
        let settings = user.settings();
        if !settings.reminders {
            continue;
        }
        let due = {
            let store = user.store();
            user.alarms.collect(store.tasks(), store.lists(), settings.default_reminder, chrono::Utc::now())
        };
        if !due.is_empty() {
            user.emit("reminders", &due);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_session_cookie() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; tasksng_session=abc ; b=2"));
        assert_eq!(session_token(&h).as_deref(), Some("abc"));
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("tasksng_session="));
        assert_eq!(session_token(&h), None);
    }
}

