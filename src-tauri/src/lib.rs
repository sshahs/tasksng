//! Tauri shell: exposes the task store to the UI and runs synchronisation in
//! the background so every UI action completes instantly.

mod secrets;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tasks_core::dav::{normalize_url, Credentials, DavClient};
use tasks_core::model::{NewTask, PatchOutcome, Task, TaskPatch};
use tasks_core::store::{write_atomic, Account, Snapshot, Store, TaskList};
use tasks_core::sync::{self, SyncReport};
use tasks_core::Error;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct Connection {
    client: DavClient,
    home: Url,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatus {
    /// `idle`, `syncing`, `offline`, `error`, `auth-required` or `signed-out`.
    state: &'static str,
    message: Option<String>,
    last_sync: Option<String>,
    pending: usize,
}

struct AppState {
    data_dir: PathBuf,
    store: Arc<Mutex<Store>>,
    conn: RwLock<Option<Arc<Connection>>>,
    sync_lock: tokio::sync::Mutex<()>,
    save_lock: tokio::sync::Mutex<()>,
    push_pending: AtomicBool,
    save_pending: AtomicBool,
    status: Mutex<SyncStatus>,
}

impl AppState {
    fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn connection(&self) -> Option<Arc<Connection>> {
        self.conn.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set_connection(&self, conn: Option<Connection>) {
        *self.conn.write().unwrap_or_else(|p| p.into_inner()) = conn.map(Arc::new);
    }
}

fn err(e: Error) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Events & background work

fn emit_snapshot(app: &AppHandle) {
    let snapshot = app.state::<AppState>().store().snapshot();
    let _ = app.emit("snapshot", snapshot);
}

fn set_status(app: &AppHandle, state: &'static str, message: Option<String>) {
    let s = app.state::<AppState>();
    let (last_sync, pending) = {
        let store = s.store();
        (store.last_sync().map(str::to_string), store.pending_count())
    };
    let status = SyncStatus { state, message, last_sync, pending };
    *s.status.lock().unwrap_or_else(|p| p.into_inner()) = status.clone();
    let _ = app.emit("sync-status", status);
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
fn schedule_save(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.save_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let state = app.state::<AppState>();
        let _guard = state.save_lock.lock().await;
        state.save_pending.store(false, Ordering::SeqCst);
        let data = state.store().take_unsaved();
        if let Some((path, bytes)) = data {
            let res = tauri::async_runtime::spawn_blocking(move || write_atomic(&path, &bytes)).await;
            if let Ok(Err(e)) = res {
                log::error!("saving cache failed: {e}");
            }
        }
    });
}

/// Sends local changes to the server shortly after they were made.
fn schedule_push(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.push_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let state = app.state::<AppState>();
        state.push_pending.store(false, Ordering::SeqCst);
        let Some(conn) = state.connection() else { return };
        let _guard = state.sync_lock.lock().await;
        let mut report = SyncReport::default();
        let result = sync::push(&state.store, &conn.client, &conn.home, &mut report).await;
        if let Err(e) = &result {
            log::info!("push failed: {e}");
        }
        let (s, msg) = status_for(&result);
        set_status(&app, s, msg);
        if !report.notices.is_empty() {
            let _ = app.emit("notices", &report.notices);
        }
        emit_snapshot(&app);
        schedule_save(&app);
    });
}

fn after_local_change(app: &AppHandle) {
    schedule_save(app);
    schedule_push(app);
    let current = app.state::<AppState>().status.lock().unwrap_or_else(|p| p.into_inner()).clone();
    set_status(app, current.state, current.message);
}

async fn run_sync(app: &AppHandle, state: &AppState) -> Result<Vec<String>, Error> {
    let Some(conn) = state.connection() else {
        let signed_in = state.store().account().is_some();
        let (s, msg) = if signed_in {
            ("auth-required", Some("Please sign in again".to_string()))
        } else {
            ("signed-out", None)
        };
        set_status(app, s, msg.clone());
        return Err(Error::Other(msg.unwrap_or_else(|| "Not signed in".into())));
    };
    let _guard = state.sync_lock.lock().await;
    set_status(app, "syncing", None);
    let result = sync::sync(&state.store, &conn.client, &conn.home, &conn.home).await;
    let (s, msg) = status_for(&result);
    set_status(app, s, msg);
    emit_snapshot(app);
    schedule_save(app);
    result.map(|r| r.notices)
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> Snapshot {
    state.store().snapshot()
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> SyncStatus {
    state.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOutcome {
    snapshot: Snapshot,
    notices: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>, args: ConnectArgs) -> Result<SyncOutcome, String> {
    let username = args.username.trim().to_string();
    if username.is_empty() {
        return Err("Enter your username".into());
    }
    let input = normalize_url(&args.server_url).map_err(err)?;
    let creds = Credentials { username: username.clone(), password: args.password.clone() };
    let client = DavClient::new(&input, creds.clone(), args.accept_invalid_certs).map_err(err)?;
    let (home, discovery) = client.discover(&input).await.map_err(err)?;
    let client = if home.host_str() != input.host_str() {
        DavClient::new(&home, creds, args.accept_invalid_certs).map_err(err)?
    } else {
        client
    };

    secrets::save(&state.data_dir, &discovery.home_url, &username, &args.password)?;
    {
        let mut store = state.store();
        if let Some(old) = store.account() {
            if old.home_url != discovery.home_url || old.username != username {
                secrets::delete(&state.data_dir, &old.home_url, &old.username);
            }
        }
        store.set_account(Account {
            server_url: args.server_url.trim().to_string(),
            username,
            principal_url: discovery.principal_url,
            home_url: discovery.home_url,
            accept_invalid_certs: args.accept_invalid_certs,
        });
    }
    state.set_connection(Some(Connection { client, home }));
    let (notices, error) = match run_sync(&app, &state).await {
        Ok(n) => (n, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    Ok(SyncOutcome { snapshot: state.store().snapshot(), notices, error })
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppState>) -> Result<Snapshot, String> {
    let _guard = state.sync_lock.lock().await;
    state.set_connection(None);
    {
        let mut store = state.store();
        if let Some(a) = store.account() {
            secrets::delete(&state.data_dir, &a.home_url, &a.username);
        }
        store.sign_out();
    }
    set_status(&app, "signed-out", None);
    schedule_save(&app);
    Ok(state.store().snapshot())
}

#[tauri::command]
async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<SyncOutcome, String> {
    let (notices, error) = match run_sync(&app, &state).await {
        Ok(n) => (n, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    Ok(SyncOutcome { snapshot: state.store().snapshot(), notices, error })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskResult {
    task: Task,
    revision: u64,
    /// For repeating tasks: the next due date after completing.
    advanced_to: Option<String>,
}

#[tauri::command(async)]
fn create_task(app: AppHandle, state: State<'_, AppState>, list_id: String, task: NewTask) -> Result<TaskResult, String> {
    let result = {
        let mut store = state.store();
        let task = store.create_task(&list_id, &task).map_err(err)?;
        TaskResult { task, revision: store.revision(), advanced_to: None }
    };
    after_local_change(&app);
    Ok(result)
}

#[tauri::command(async)]
fn update_task(app: AppHandle, state: State<'_, AppState>, id: String, patch: TaskPatch) -> Result<TaskResult, String> {
    let result = {
        let mut store = state.store();
        let (task, outcome) = store.update_task(&id, &patch).map_err(err)?;
        let advanced_to = match outcome {
            PatchOutcome::Advanced { due } => Some(due),
            PatchOutcome::Updated => None,
        };
        TaskResult { task, revision: store.revision(), advanced_to }
    };
    after_local_change(&app);
    Ok(result)
}

#[tauri::command(async)]
fn move_task(app: AppHandle, state: State<'_, AppState>, id: String, list_id: String) -> Result<Snapshot, String> {
    let snapshot = {
        let mut store = state.store();
        store.move_task(&id, &list_id).map_err(err)?;
        store.snapshot()
    };
    after_local_change(&app);
    Ok(snapshot)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResult {
    token: u64,
    snapshot: Snapshot,
}

#[tauri::command(async)]
fn delete_tasks(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<DeleteResult, String> {
    let result = {
        let mut store = state.store();
        let token = store.delete_tasks(&ids).map_err(err)?;
        DeleteResult { token, snapshot: store.snapshot() }
    };
    after_local_change(&app);
    Ok(result)
}

#[tauri::command(async)]
fn undo_delete(app: AppHandle, state: State<'_, AppState>, token: u64) -> Result<Snapshot, String> {
    let snapshot = {
        let mut store = state.store();
        store.undo_delete(token).map_err(err)?;
        store.snapshot()
    };
    after_local_change(&app);
    Ok(snapshot)
}

fn require_connection(state: &AppState) -> Result<Arc<Connection>, String> {
    state.connection().ok_or_else(|| "You are not signed in".to_string())
}

fn list_url(conn: &Connection, id: &str) -> Result<Url, String> {
    conn.home.join(id).map_err(|e| e.to_string())
}

fn online_err(e: Error) -> String {
    if e.is_offline() {
        "Lists can only be changed while connected to the server".into()
    } else {
        e.to_string()
    }
}

#[tauri::command]
async fn create_list(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<Snapshot, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the list a name".into());
    }
    let conn = require_connection(&state)?;
    let _guard = state.sync_lock.lock().await;
    let href = conn.client.make_calendar(&conn.home, &name, color.as_deref()).await.map_err(online_err)?;
    state.store().add_list(TaskList { id: href, name, color, order: None, read_only: false, ctag: None });
    emit_snapshot(&app);
    schedule_save(&app);
    Ok(state.store().snapshot())
}

#[tauri::command]
async fn update_list(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<Snapshot, String> {
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let conn = require_connection(&state)?;
    let _guard = state.sync_lock.lock().await;
    conn.client
        .update_calendar(&list_url(&conn, &id)?, name.as_deref(), color.as_deref())
        .await
        .map_err(online_err)?;
    state.store().rename_list(&id, name.as_deref(), color.as_deref());
    emit_snapshot(&app);
    schedule_save(&app);
    Ok(state.store().snapshot())
}

#[tauri::command]
async fn delete_list(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Snapshot, String> {
    let conn = require_connection(&state)?;
    let _guard = state.sync_lock.lock().await;
    conn.client.delete_calendar(&list_url(&conn, &id)?).await.map_err(online_err)?;
    state.store().remove_list(&id);
    emit_snapshot(&app);
    schedule_save(&app);
    Ok(state.store().snapshot())
}

// ---------------------------------------------------------------------------

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(2_000_000)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = Store::open(&data_dir.join("tasks-cache.json"));
            let mut status = SyncStatus { state: "signed-out", message: None, last_sync: None, pending: 0 };
            let mut conn = None;
            if let Some(account) = store.account() {
                status.last_sync = store.last_sync().map(str::to_string);
                status.pending = store.pending_count();
                let password = secrets::load(&data_dir, &account.home_url, &account.username);
                match (password, Url::parse(&account.home_url)) {
                    (Some(password), Ok(home)) => {
                        let creds = Credentials { username: account.username.clone(), password };
                        match DavClient::new(&home, creds, account.accept_invalid_certs) {
                            Ok(client) => {
                                conn = Some(Arc::new(Connection { client, home }));
                                status.state = "idle";
                            }
                            Err(e) => {
                                status.state = "error";
                                status.message = Some(e.to_string());
                            }
                        }
                    }
                    _ => {
                        status.state = "auth-required";
                        status.message = Some("Please sign in again".into());
                    }
                }
            }
            app.manage(AppState {
                data_dir,
                store: Arc::new(Mutex::new(store)),
                conn: RwLock::new(conn),
                sync_lock: tokio::sync::Mutex::new(()),
                save_lock: tokio::sync::Mutex::new(()),
                push_pending: AtomicBool::new(false),
                save_pending: AtomicBool::new(false),
                status: Mutex::new(status),
            });

            // The UI shows the window once it has painted; this is a safety
            // net in case the web view fails to load.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_status,
            connect,
            sign_out,
            sync_now,
            create_task,
            update_task,
            move_task,
            delete_tasks,
            undo_delete,
            create_list,
            update_list,
            delete_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building TasksNG");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                let _guard = state.save_lock.blocking_lock();
                if let Err(e) = state.store().save_now() {
                    log::error!("saving cache on exit failed: {e}");
                }
            }
        }
    });
}
