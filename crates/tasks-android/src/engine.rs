//! One signed-in account on a phone: the task cache, the connection to the
//! CalDAV server and the background work around them (saving, pushing).
//!
//! The Android app talks to it with commands that take and return JSON, the
//! same ones the web server and the desktop app use (see `dispatch`), and
//! reads what happened in the background from an event queue.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use chrono::Utc;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tasks_core::alarms::Alarms;
use tasks_core::dav::{normalize_url, Credentials, DavClient};
use tasks_core::events::{self, EventsResult};
use tasks_core::model::{NewTask, PatchOutcome, TaskPatch, TaskStatus};
use tasks_core::settings::{self, Settings, SettingsPatch};
use tasks_core::store::{write_atomic, Account, Resolution, Store, TaskList};
use tasks_core::sync::{self, SyncReport};
use tasks_core::Error;
use url::Url;

struct Connection {
    client: DavClient,
    home: Url,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// `idle`, `syncing`, `offline`, `error`, `auth-required` or `signed-out`.
    pub state: &'static str,
    pub message: Option<String>,
    pub last_sync: Option<String>,
    pub pending: usize,
}

/// Something that happened in the background, for the app to pick up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    pub name: &'static str,
    /// JSON, or empty.
    pub data: String,
}

#[derive(Default)]
struct EventQueue {
    queue: Mutex<VecDeque<Event>>,
    ready: Condvar,
}

impl EventQueue {
    fn push(&self, name: &'static str, data: String) {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        // "changed" and "status" only say "look again": one in the queue is enough.
        if matches!(name, "changed" | "status") {
            q.retain(|e| e.name != name);
        }
        // Nobody is listening (the app's process is being started for a
        // reminder, say): don't grow without bound.
        if q.len() > 256 {
            q.pop_front();
        }
        q.push_back(Event { name, data });
        self.ready.notify_all();
    }

    fn next(&self, timeout: Duration) -> Option<Event> {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        if q.is_empty() {
            q = self.ready.wait_timeout(q, timeout).unwrap_or_else(|p| p.into_inner()).0;
        }
        q.pop_front()
    }
}

struct Inner {
    dir: PathBuf,
    store: Arc<Mutex<Store>>,
    conn: RwLock<Option<Arc<Connection>>>,
    sync_lock: tokio::sync::Mutex<()>,
    save_lock: tokio::sync::Mutex<()>,
    push_pending: AtomicBool,
    save_pending: AtomicBool,
    status: Mutex<SyncStatus>,
    settings: Mutex<Settings>,
    alarms: Alarms,
    events: EventQueue,
}

pub struct Engine {
    rt: tokio::runtime::Runtime,
    inner: Arc<Inner>,
}

type CmdResult = Result<Value, String>;

fn args<T: DeserializeOwned>(body: &Value) -> Result<T, String> {
    T::deserialize(body).map_err(|e| format!("Invalid request: {e}"))
}

fn to_value<T: Serialize>(v: T) -> CmdResult {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn status_for<T>(result: &Result<T, Error>) -> (&'static str, Option<String>) {
    match result {
        Ok(_) => ("idle", None),
        Err(Error::Unauthorized) => ("auth-required", Some(Error::Unauthorized.to_string())),
        Err(e) if e.is_offline() => ("offline", Some(e.to_string())),
        Err(e) => ("error", Some(e.to_string())),
    }
}

fn online_err(e: Error) -> String {
    if e.is_offline() {
        "Lists can only be changed while connected to the server".into()
    } else {
        e.to_string()
    }
}

impl Inner {
    fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn connection(&self) -> Option<Arc<Connection>> {
        self.conn.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set_connection(&self, conn: Option<Connection>) {
        *self.conn.write().unwrap_or_else(|p| p.into_inner()) = conn.map(Arc::new);
    }

    fn status(&self) -> SyncStatus {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set_status(&self, state: &'static str, message: Option<String>) {
        let (last_sync, pending) = {
            let store = self.store();
            (store.last_sync().map(str::to_string), store.pending_count())
        };
        let status = SyncStatus { state, message, last_sync, pending };
        let data = serde_json::to_string(&status).unwrap_or_default();
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = status;
        self.events.push("status", data);
    }

    fn changed(&self) {
        self.events.push("changed", String::new());
    }

    /// Opens the connection for the account in the cache.
    fn connect_saved(&self, password: Option<&str>) {
        let account = self.store().account().cloned();
        let Some(account) = account else {
            self.set_status("signed-out", None);
            return;
        };
        let (state, message) = match (password, Url::parse(&account.home_url)) {
            (Some(password), Ok(home)) => {
                let creds = Credentials { username: account.username.clone(), password: password.to_string() };
                match DavClient::new(&home, creds, account.accept_invalid_certs) {
                    Ok(client) => {
                        self.set_connection(Some(Connection { client, home }));
                        ("idle", None)
                    }
                    Err(e) => ("error", Some(e.to_string())),
                }
            }
            _ => ("auth-required", Some("Please sign in again".to_string())),
        };
        self.set_status(state, message);
    }
}

/// Persists the cache shortly after changes (bursts of edits are one write).
fn schedule_save(inner: &Arc<Inner>) {
    if inner.save_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let inner = inner.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        save_now(&inner).await;
    });
}

async fn save_now(inner: &Inner) {
    let _guard = inner.save_lock.lock().await;
    inner.save_pending.store(false, Ordering::SeqCst);
    let data = inner.store().take_unsaved();
    if let Some((path, bytes)) = data {
        let res = tokio::task::spawn_blocking(move || write_atomic(&path, &bytes)).await;
        if let Ok(Err(e)) = res {
            log::error!("saving the cache failed: {e}");
        }
    }
}

/// Sends local changes to the server shortly after they were made.
fn schedule_push(inner: &Arc<Inner>) {
    if inner.push_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let inner = inner.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        inner.push_pending.store(false, Ordering::SeqCst);
        let Some(conn) = inner.connection() else { return };
        let _guard = inner.sync_lock.lock().await;
        let mut report = SyncReport::default();
        let result = sync::push(&inner.store, &conn.client, &conn.home, &mut report).await;
        if let Err(e) = &result {
            log::info!("push failed: {e}");
        }
        let (s, msg) = status_for(&result);
        inner.set_status(s, msg);
        if !report.notices.is_empty() {
            inner.events.push("notices", serde_json::to_string(&report.notices).unwrap_or_default());
        }
        if result.is_ok() {
            // Paired browsers refresh right away instead of on their next sync.
            inner.events.push("pushed", String::new());
        }
        inner.changed();
        schedule_save(&inner);
    });
}

/// After a local edit: save, push, and tell the app.
fn after_local_change(inner: &Arc<Inner>) {
    schedule_save(inner);
    schedule_push(inner);
    inner.changed();
    let current = inner.status();
    inner.set_status(current.state, current.message);
}

async fn run_sync(inner: &Arc<Inner>) -> Result<Vec<String>, Error> {
    let Some(conn) = inner.connection() else {
        let msg = "Please sign in again".to_string();
        if inner.store().account().is_some() {
            inner.set_status("auth-required", Some(msg.clone()));
        }
        return Err(Error::Other(msg));
    };
    let _guard = inner.sync_lock.lock().await;
    inner.set_status("syncing", None);
    let before = inner.store().revision();
    let result = sync::sync(&inner.store, &conn.client, &conn.home, &conn.home).await;
    let (s, msg) = status_for(&result);
    inner.set_status(s, msg);
    if inner.store().revision() != before {
        inner.changed();
    }
    schedule_save(inner);
    result.map(|r| r.notices)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    server_url: String,
    username: String,
    password: String,
    #[serde(default)]
    accept_invalid_certs: bool,
}

#[derive(Debug, Deserialize)]
struct TaskUpdate {
    id: String,
    patch: TaskPatch,
}

async fn connect(inner: &Arc<Inner>, a: ConnectArgs) -> CmdResult {
    let username = a.username.trim().to_string();
    if username.is_empty() {
        return Err("Enter your username".into());
    }
    let server_url = a.server_url.trim().to_string();
    let input = normalize_url(&server_url).map_err(|e| e.to_string())?;
    let creds = Credentials { username: username.clone(), password: a.password.clone() };
    let client = DavClient::new(&input, creds.clone(), a.accept_invalid_certs).map_err(|e| e.to_string())?;
    let (home, discovery) = client.discover(&input).await.map_err(|e| e.to_string())?;
    let client = if home.host_str() != input.host_str() {
        DavClient::new(&home, creds, a.accept_invalid_certs).map_err(|e| e.to_string())?
    } else {
        client
    };
    {
        let _guard = inner.sync_lock.lock().await;
        inner.store().set_account(Account {
            server_url,
            username,
            principal_url: discovery.principal_url,
            home_url: discovery.home_url,
            accept_invalid_certs: a.accept_invalid_certs,
        });
        inner.set_connection(Some(Connection { client, home }));
    }
    let (notices, error) = match run_sync(inner).await {
        Ok(n) => (n, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    inner.changed();
    Ok(json!({ "snapshot": inner.store().snapshot(), "notices": notices, "error": error }))
}

async fn get_events(inner: &Arc<Inner>, body: &Value) -> CmdResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct A {
        from: String,
        to: String,
        /// Only what was downloaded before: no request.
        #[serde(default)]
        cached_only: bool,
    }
    let a: A = args(body)?;
    let (start, end) = events::parse_range(&a.from, &a.to).map_err(|e| e.to_string())?;
    let cached =
        || inner.store().cached_events(&a.from, &a.to).map(|c| (c.events.clone(), Some(c.fetched_at.clone()))).unwrap_or_default();
    let conn = if a.cached_only { None } else { inner.connection() };
    let Some(conn) = conn else {
        let (events, fetched_at) = cached();
        return to_value(EventsResult { events, fetched_at, error: None });
    };
    match sync::fetch_events(&conn.client, &conn.home, &conn.home, start, end).await {
        Ok(events) => {
            inner.store().cache_events(&a.from, &a.to, events.clone());
            schedule_save(inner);
            let fetched_at = inner.store().cached_events(&a.from, &a.to).map(|c| c.fetched_at.clone());
            to_value(EventsResult { events, fetched_at, error: None })
        }
        Err(e) => {
            let (events, fetched_at) = cached();
            to_value(EventsResult { events, fetched_at, error: Some(e.to_string()) })
        }
    }
}

async fn list_command(inner: &Arc<Inner>, cmd: &str, body: &Value) -> CmdResult {
    let conn = inner.connection().ok_or("You are not signed in")?;
    let list_url = |id: &str| conn.home.join(id).map_err(|e| e.to_string());
    let _guard = inner.sync_lock.lock().await;
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
                return Err("Give the list a name".into());
            }
            let href = conn.client.make_calendar(&conn.home, &name, a.color.as_deref()).await.map_err(online_err)?;
            inner.store().add_list(TaskList { id: href, name, color: a.color, order: None, read_only: false, ctag: None });
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
            inner.store().rename_list(&a.id, name.as_deref(), a.color.as_deref());
        }
        _ => {
            #[derive(Deserialize)]
            struct A {
                id: String,
            }
            let a: A = args(body)?;
            conn.client.delete_calendar(&list_url(&a.id)?).await.map_err(online_err)?;
            inner.store().remove_list(&a.id);
        }
    }
    inner.changed();
    schedule_save(inner);
    to_value(inner.store().snapshot())
}

async fn dispatch(inner: &Arc<Inner>, cmd: &str, body: &Value) -> CmdResult {
    match cmd {
        "get_snapshot" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct A {
                /// Answer `null` when nothing changed since this revision.
                if_newer: Option<u64>,
            }
            let a: A = args(body)?;
            let store = inner.store();
            if a.if_newer == Some(store.revision()) {
                return Ok(Value::Null);
            }
            to_value(store.snapshot())
        }
        "get_status" => to_value(inner.status()),
        "connect" => connect(inner, args(body)?).await,
        // The password is kept by the app (encrypted with the Android
        // Keystore) and handed over when the process starts.
        "restore" => {
            #[derive(Deserialize)]
            struct A {
                password: Option<String>,
            }
            let a: A = args(body)?;
            inner.connect_saved(a.password.as_deref());
            to_value(inner.status())
        }
        "sign_out" => {
            {
                let _guard = inner.sync_lock.lock().await;
                inner.set_connection(None);
                inner.store().sign_out();
            }
            inner.set_status("signed-out", None);
            save_now(inner).await;
            inner.changed();
            to_value(inner.store().snapshot())
        }
        "sync_now" => {
            let (notices, error) = match run_sync(inner).await {
                Ok(n) => (n, None),
                Err(e) => (Vec::new(), Some(e.to_string())),
            };
            Ok(json!({ "notices": notices, "error": error }))
        }
        // Before the process may be stopped: write the cache now.
        "flush" => {
            save_now(inner).await;
            Ok(Value::Null)
        }
        "create_task" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                list_id: String,
                task: NewTask,
            }
            let a: A = args(body)?;
            let task = inner.store().create_task(&a.list_id, &a.task).map_err(|e| e.to_string())?;
            after_local_change(inner);
            Ok(json!({ "task": task, "advancedTo": null }))
        }
        "update_task" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                patch: TaskPatch,
            }
            let a: A = args(body)?;
            let (task, outcome) = inner.store().update_task(&a.id, &a.patch).map_err(|e| e.to_string())?;
            let advanced_to = match outcome {
                PatchOutcome::Advanced { due } => Some(due),
                PatchOutcome::Updated => None,
            };
            after_local_change(inner);
            Ok(json!({ "task": task, "advancedTo": advanced_to }))
        }
        "update_tasks" => {
            #[derive(Deserialize)]
            struct A {
                updates: Vec<TaskUpdate>,
            }
            let a: A = args(body)?;
            let updates: Vec<(String, TaskPatch)> = a.updates.into_iter().map(|u| (u.id, u.patch)).collect();
            inner.store().update_tasks(&updates).map_err(|e| e.to_string())?;
            after_local_change(inner);
            Ok(Value::Null)
        }
        "move_task" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                list_id: String,
            }
            let a: A = args(body)?;
            let task = inner.store().move_task(&a.id, &a.list_id).map_err(|e| e.to_string())?;
            after_local_change(inner);
            Ok(json!({ "task": task }))
        }
        "delete_tasks" => {
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
            }
            let a: A = args(body)?;
            let token = inner.store().delete_tasks(&a.ids).map_err(|e| e.to_string())?;
            after_local_change(inner);
            Ok(json!({ "token": token }))
        }
        "undo_delete" => {
            #[derive(Deserialize)]
            struct A {
                token: u64,
            }
            let a: A = args(body)?;
            inner.store().undo_delete(a.token).map_err(|e| e.to_string())?;
            after_local_change(inner);
            Ok(Value::Null)
        }
        "resolve_conflict" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                resolution: Resolution,
            }
            let a: A = args(body)?;
            inner.store().resolve_conflict(&a.id, &a.resolution).map_err(|e| e.to_string())?;
            after_local_change(inner);
            Ok(Value::Null)
        }
        "task_history" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
            }
            let a: A = args(body)?;
            to_value(inner.store().history(&a.id))
        }
        "create_list" | "update_list" | "delete_list" => list_command(inner, cmd, body).await,
        "get_events" => get_events(inner, body).await,
        "get_settings" => to_value(inner.settings()),
        "update_settings" => {
            #[derive(Deserialize)]
            struct A {
                patch: SettingsPatch,
            }
            let a: A = args(body)?;
            let mut settings = inner.settings();
            let was_on = settings.reminders;
            settings.apply(&a.patch);
            settings::save(&inner.dir.join("settings.json"), &settings);
            *inner.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings.clone();
            if settings.reminders && !was_on {
                inner.alarms.restart();
            }
            to_value(settings)
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
                    let id = inner.store().task_by_uid(&a.uid).filter(|t| !t.completed).map(|t| t.id.clone());
                    if let Some(id) = id {
                        let patch = TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() };
                        inner.store().update_task(&id, &patch).map_err(|e| e.to_string())?;
                        after_local_change(inner);
                    }
                }
                "snooze" => {
                    inner.alarms.snooze(&a.uid, a.minutes.unwrap_or(10));
                    // The alarms given to the system have to follow.
                    inner.changed();
                }
                _ => {}
            }
            Ok(Value::Null)
        }
        // Reminders that go off in the coming days, for Android's alarm
        // service: they then appear while TasksNG isn't running.
        "upcoming_reminders" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                days: i64,
                max: usize,
            }
            let a: A = args(body)?;
            let settings = inner.settings();
            if !settings.reminders {
                return Ok(json!([]));
            }
            let now = Utc::now();
            let store = inner.store();
            let upcoming = inner.alarms.upcoming(
                store.tasks(),
                store.lists(),
                settings.default_reminder,
                now,
                now + chrono::Duration::days(a.days.clamp(1, 366)),
            );
            Ok(Value::Array(
                upcoming
                    .into_iter()
                    .take(a.max)
                    .map(|u| {
                        json!({
                            "at": u.at.timestamp_millis(),
                            "uid": u.reminder.uid,
                            "id": u.reminder.id,
                            "title": u.reminder.title,
                            "body": u.reminder.body,
                        })
                    })
                    .collect(),
            ))
        }
        // Reminders that are due now and weren't shown yet (the ones the
        // system never got, e.g. synced from another device after their time).
        "due_reminders" => {
            let settings = inner.settings();
            if !settings.reminders {
                return Ok(json!([]));
            }
            let store = inner.store();
            to_value(inner.alarms.collect(store.tasks(), store.lists(), settings.default_reminder, Utc::now()))
        }
        _ => Err(format!("Unknown command {cmd}")),
    }
}

impl Engine {
    /// Opens the cache in `dir`. `password` is the signed-in account's, if
    /// the app has one stored.
    pub fn open(dir: &Path, password: Option<&str>) -> std::io::Result<Engine> {
        std::fs::create_dir_all(dir)?;
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("tasksng").enable_all().build()?;
        let store = Store::open(&dir.join("tasks-cache.json"));
        let status = SyncStatus {
            state: "signed-out",
            message: None,
            last_sync: store.last_sync().map(str::to_string),
            pending: store.pending_count(),
        };
        let inner = Arc::new(Inner {
            dir: dir.to_path_buf(),
            store: Arc::new(Mutex::new(store)),
            conn: RwLock::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            save_lock: tokio::sync::Mutex::new(()),
            push_pending: AtomicBool::new(false),
            save_pending: AtomicBool::new(false),
            status: Mutex::new(status),
            settings: Mutex::new(settings::load(&dir.join("settings.json"))),
            alarms: Alarms::open(&dir.join("reminders.json")),
            events: EventQueue::default(),
        });
        inner.connect_saved(password);
        // Changes that didn't reach the server before the app was closed.
        if inner.connection().is_some() && inner.store().pending_count() > 0 {
            let _enter = rt.enter();
            schedule_push(&inner);
        }
        Ok(Engine { rt, inner })
    }

    /// Runs a command and answers `{"ok": …}` or `{"error": "…"}`.
    pub fn invoke(&self, cmd: &str, args: &str) -> String {
        let body: Value = if args.trim().is_empty() { json!({}) } else { serde_json::from_str(args).unwrap_or_else(|_| json!({})) };
        let inner = self.inner.clone();
        let result = self.rt.block_on(async move { dispatch(&inner, cmd, &body).await });
        match result {
            Ok(v) => json!({ "ok": v }).to_string(),
            Err(e) => json!({ "error": e }).to_string(),
        }
    }

    /// Waits for the next background event.
    pub fn next_event(&self, timeout: Duration) -> Option<Event> {
        self.inner.events.next(timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(engine: &Engine, cmd: &str, args: Value) -> Value {
        let out: Value = serde_json::from_str(&engine.invoke(cmd, &args.to_string())).unwrap();
        assert!(out.get("error").is_none(), "{cmd}: {out}");
        out["ok"].clone()
    }

    #[test]
    fn starts_signed_out_and_reports_unknown_commands() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), None).unwrap();
        assert_eq!(ok(&engine, "get_status", json!({}))["state"], "signed-out");
        let snapshot = ok(&engine, "get_snapshot", json!({}));
        assert!(snapshot["account"].is_null());
        let revision = snapshot["revision"].as_u64().unwrap();
        assert!(ok(&engine, "get_snapshot", json!({ "ifNewer": revision })).is_null());
        let out: Value = serde_json::from_str(&engine.invoke("nope", "")).unwrap();
        assert_eq!(out["error"], "Unknown command nope");
    }

    #[test]
    fn settings_are_kept_and_events_are_coalesced() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), None).unwrap();
        let s = ok(&engine, "update_settings", json!({ "patch": { "reminders": false, "defaultReminder": -600 } }));
        assert_eq!(s["reminders"], false);
        assert_eq!(s["defaultReminder"], -600);
        drop(engine);
        let engine = Engine::open(dir.path(), None).unwrap();
        assert_eq!(ok(&engine, "get_settings", json!({}))["defaultReminder"], -600);

        engine.inner.changed();
        engine.inner.changed();
        let mut names = Vec::new();
        while let Some(e) = engine.next_event(Duration::from_millis(10)) {
            names.push(e.name);
        }
        assert_eq!(names.iter().filter(|n| **n == "changed").count(), 1);
        assert_eq!(names.iter().filter(|n| **n == "status").count(), 1);
    }

    #[test]
    fn upcoming_reminders_need_reminders_switched_on() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), None).unwrap();
        ok(&engine, "update_settings", json!({ "patch": { "reminders": false } }));
        assert_eq!(ok(&engine, "upcoming_reminders", json!({ "days": 30, "max": 10 })), json!([]));
        assert_eq!(ok(&engine, "due_reminders", json!({})), json!([]));
    }
}
