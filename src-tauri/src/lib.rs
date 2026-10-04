//! Tauri shell: exposes the task store to the UI and runs synchronisation in
//! the background so every UI action completes instantly.

mod notify;
mod quick_add;
mod secrets;
mod settings;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use notify::{Toast, ToastAction};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use settings::Settings;
use tasks_core::alarms::{Alarms, DueReminder};
use tasks_core::dav::{normalize_url, Credentials, DavClient};
use tasks_core::model::{NewTask, PatchOutcome, Task, TaskPatch, TaskStatus};
use tasks_core::store::{write_atomic, Account, Snapshot, Store, TaskList};
use tasks_core::sync::{self, SyncReport};
use tasks_core::Error;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

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

pub(crate) struct AppState {
    data_dir: PathBuf,
    store: Arc<Mutex<Store>>,
    conn: RwLock<Option<Arc<Connection>>>,
    sync_lock: tokio::sync::Mutex<()>,
    save_lock: tokio::sync::Mutex<()>,
    push_pending: AtomicBool,
    save_pending: AtomicBool,
    status: Mutex<SyncStatus>,
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    shortcut_error: Mutex<Option<String>>,
    alarms: Alarms,
    /// Started with Windows (`--hidden`): stay in the notification area.
    start_hidden: bool,
    pub(crate) quick_add_pending: AtomicBool,
    pub(crate) quick_add_loaded: AtomicBool,
}

impl AppState {
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

pub(crate) async fn run_sync(app: &AppHandle, state: &AppState) -> Result<Vec<String>, Error> {
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
fn create_task(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    list_id: String,
    task: NewTask,
) -> Result<TaskResult, String> {
    let result = {
        let mut store = state.store();
        let task = store.create_task(&list_id, &task).map_err(err)?;
        TaskResult { task, revision: store.revision(), advanced_to: None }
    };
    after_local_change(&app);
    // Added from the quick add window: the main window has to hear about it.
    if window.label() != "main" {
        emit_snapshot(&app);
    }
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

#[derive(Debug, Deserialize)]
struct TaskUpdate {
    id: String,
    patch: TaskPatch,
}

/// Several edits at once, e.g. after reordering by drag and drop.
#[tauri::command(async)]
fn update_tasks(app: AppHandle, state: State<'_, AppState>, updates: Vec<TaskUpdate>) -> Result<Snapshot, String> {
    let snapshot = {
        let mut store = state.store();
        let updates: Vec<(String, TaskPatch)> = updates.into_iter().map(|u| (u.id, u.patch)).collect();
        store.update_tasks(&updates).map_err(err)?;
        store.snapshot()
    };
    after_local_change(&app);
    Ok(snapshot)
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

/// Writes the cache to disk right away. Called before an update is installed:
/// on Windows the updater ends the process without the usual exit events.
#[tauri::command]
async fn prepare_for_update(state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.save_lock.lock().await;
    state.store().save_now().map_err(err)
}

/// Whether this copy can update itself: true for the NSIS (per-user) and MSI
/// installs, false for the portable exe, which would otherwise run the
/// installer and end up as a second, installed copy.
#[tauri::command]
fn updates_supported() -> bool {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else { return false };
        if exe.parent().is_some_and(|dir| dir.join("uninstall.exe").exists()) {
            return true;
        }
        let exe = exe.to_string_lossy().to_lowercase();
        ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .any(|dir| exe.starts_with(&dir.to_lowercase()))
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// The main window's page has painted; show it unless TasksNG was started
/// with Windows into the notification area.
#[tauri::command]
fn window_ready(app: AppHandle, window: tauri::Window, state: State<'_, AppState>) {
    match window.label() {
        "main" if !state.start_hidden => show_main_window(&app),
        quick_add::LABEL => quick_add::ready(&app),
        _ => {}
    }
}

#[tauri::command]
fn hide_quick_add(app: AppHandle) {
    quick_add::hide(&app);
}

// ---------------------------------------------------------------------------
// Settings

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    launch_at_login: bool,
    shortcut_error: Option<String>,
    /// Reminders appear as Windows notifications (false in development
    /// builds on other systems, where they show inside the app).
    native_notifications: bool,
}

fn settings_view(app: &AppHandle) -> SettingsView {
    let state = app.state::<AppState>();
    let shortcut_error = state.shortcut_error.lock().unwrap_or_else(|p| p.into_inner()).clone();
    SettingsView {
        settings: state.settings(),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        shortcut_error,
        native_notifications: cfg!(windows),
    }
}

/// Registers the quick add shortcut; returns a message if that failed.
fn apply_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Option<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let shortcut = shortcut.map(str::trim).filter(|s| !s.is_empty())?;
    match gs.register(shortcut) {
        Ok(()) => None,
        Err(e) => {
            log::warn!("registering {shortcut} failed: {e}");
            Some(format!(
                "{} is already used by Windows or another app. Pick a different shortcut.",
                shortcut.replace("Super", "Win")
            ))
        }
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> SettingsView {
    settings_view(&app)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
    launch_at_login: bool,
) -> Result<SettingsView, String> {
    let old = state.settings();
    if old.quick_add_shortcut != settings.quick_add_shortcut {
        let error = apply_shortcut(&app, settings.quick_add_shortcut.as_deref());
        *state.shortcut_error.lock().unwrap_or_else(|p| p.into_inner()) = error;
        if settings.quick_add_shortcut.is_some() {
            quick_add::prepare(&app);
        }
    }
    if settings.reminders && !old.reminders {
        state.alarms.restart();
    }
    let autolaunch = app.autolaunch();
    if autolaunch.is_enabled().unwrap_or(false) != launch_at_login {
        let res = if launch_at_login { autolaunch.enable() } else { autolaunch.disable() };
        res.map_err(|e| format!("Couldn't change the start-up setting: {e}"))?;
    }
    settings::save(&state.settings_path, &settings);
    *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings;
    Ok(settings_view(&app))
}

/// Pauses the global shortcut while a new one is being recorded in
/// Settings (otherwise pressing the current one would open quick add).
#[tauri::command]
fn suspend_shortcut(app: AppHandle, state: State<'_, AppState>, suspend: bool) {
    if suspend {
        let _ = app.global_shortcut().unregister_all();
    } else {
        let error = apply_shortcut(&app, state.settings().quick_add_shortcut.as_deref());
        *state.shortcut_error.lock().unwrap_or_else(|p| p.into_inner()) = error;
    }
}

/// Opens a link from a task's notes in the default browser or mail app.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "That isn't a valid link".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Only web and e-mail links can be opened".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Reminders

fn app_id(app: &AppHandle) -> String {
    app.config().identifier.clone()
}

fn toast_handler(app: &AppHandle) -> notify::Handler {
    let app = app.clone();
    Arc::new(move |action| handle_toast_action(&app, action))
}

fn handle_toast_action(app: &AppHandle, action: ToastAction) {
    let state = app.state::<AppState>();
    match action {
        ToastAction::Open(uid) => {
            show_main_window(app);
            if let Some(id) = uid.and_then(|u| state.store().task_by_uid(&u).map(|t| t.id.clone())) {
                let _ = app.emit_to("main", "open-task", id);
            }
        }
        ToastAction::Done(uid) => {
            let id = state.store().task_by_uid(&uid).filter(|t| !t.completed).map(|t| t.id.clone());
            if let Some(id) = id {
                let patch = TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() };
                let res = state.store().update_task(&id, &patch);
                match res {
                    Ok(_) => {
                        after_local_change(app);
                        emit_snapshot(app);
                    }
                    Err(e) => log::warn!("completing from a reminder failed: {e}"),
                }
            }
        }
        ToastAction::Snooze(uid, minutes) => state.alarms.snooze(&uid, minutes),
    }
}

/// Shows due reminders as notifications (or inside the app when that is
/// not possible).
fn show_reminders(app: &AppHandle, due: Vec<DueReminder>) {
    let toasts: Vec<Toast> = if due.len() > 3 {
        let mut names: Vec<&str> = due.iter().take(3).map(|d| d.title.as_str()).collect();
        if due.len() > 3 {
            names.push("…");
        }
        vec![Toast {
            title: format!("{} reminders", due.len()),
            body: names.join(", "),
            reminder_uid: None,
            open_uid: None,
        }]
    } else {
        due.iter()
            .map(|d| Toast {
                title: d.title.clone(),
                body: d.body.clone(),
                reminder_uid: Some(d.uid.clone()),
                open_uid: Some(d.uid.clone()),
            })
            .collect()
    };
    let handle = app.clone();
    let res = app.run_on_main_thread(move || {
        let id = app_id(&handle);
        let failed = toasts.iter().any(|t| {
            notify::show(&id, t, toast_handler(&handle))
                .inspect_err(|e| log::info!("notification not shown: {e}"))
                .is_err()
        });
        if failed {
            let _ = handle.emit_to("main", "reminders", &due);
        }
    });
    if let Err(e) = res {
        log::warn!("showing reminders failed: {e}");
    }
}

fn check_reminders(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.reminders {
        return;
    }
    let due = {
        let store = state.store();
        state.alarms.collect(store.tasks(), store.lists(), settings.default_reminder, chrono::Utc::now())
    };
    if !due.is_empty() {
        show_reminders(app, due);
    }
}

/// Snooze or complete from the in-app reminder message.
#[tauri::command]
fn reminder_action(app: AppHandle, uid: String, action: String, minutes: Option<u32>) {
    let action = match action.as_str() {
        "done" => ToastAction::Done(uid),
        "snooze" => ToastAction::Snooze(uid, minutes.unwrap_or(notify::DEFAULT_SNOOZE)),
        _ => ToastAction::Open(Some(uid)),
    };
    handle_toast_action(&app, action);
}

/// Shows a sample reminder so people can check notifications are allowed.
#[tauri::command]
fn test_notification(app: AppHandle) -> Result<(), String> {
    let toast = Toast {
        title: "This is how reminders look".into(),
        body: "Snooze or complete tasks right from the notification.".into(),
        reminder_uid: Some(String::new()),
        open_uid: None,
    };
    notify::show(&app_id(&app), &toast, toast_handler(&app))
}

// ---------------------------------------------------------------------------

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Closing the main window hides it to the notification area (once with a
/// hint), unless that is turned off.
fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        ("main", WindowEvent::CloseRequested { api, .. }) => {
            let state = app.state::<AppState>();
            let mut settings = state.settings();
            if !settings.close_to_tray {
                app.exit(0);
                return;
            }
            api.prevent_close();
            let _ = window.hide();
            if !settings.tray_hint_shown {
                settings.tray_hint_shown = true;
                settings::save(&state.settings_path, &settings);
                *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings;
                let toast = Toast {
                    title: "TasksNG is still running".into(),
                    body: "It stays in the notification area so reminders can appear. Right-click its icon to quit, or change this in Settings."
                        .into(),
                    reminder_uid: None,
                    open_uid: None,
                };
                let _ = notify::show(&app_id(app), &toast, toast_handler(app));
            }
        }
        (quick_add::LABEL, WindowEvent::Focused(false)) => quick_add::hide(app),
        (quick_add::LABEL, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            quick_add::hide(app);
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second "start with Windows" launch shouldn't pop the window up.
            if !args.iter().any(|a| a == "--hidden") {
                show_main_window(app);
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(2_000_000)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        quick_add::toggle(app);
                    }
                })
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .on_window_event(on_window_event)
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = Store::open(&data_dir.join("tasks-cache.json"));
            let settings_path = data_dir.join("settings.json");
            let settings = settings::load(&settings_path);
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
            let start_hidden = std::env::args().any(|a| a == "--hidden");
            let shortcut = settings.quick_add_shortcut.clone();
            notify::register(&app.config().identifier, &data_dir);
            app.manage(AppState {
                alarms: Alarms::open(&data_dir.join("reminders.json")),
                data_dir,
                store: Arc::new(Mutex::new(store)),
                conn: RwLock::new(conn),
                sync_lock: tokio::sync::Mutex::new(()),
                save_lock: tokio::sync::Mutex::new(()),
                push_pending: AtomicBool::new(false),
                save_pending: AtomicBool::new(false),
                status: Mutex::new(status),
                settings_path,
                settings: Mutex::new(settings),
                shortcut_error: Mutex::new(None),
                start_hidden,
                quick_add_pending: AtomicBool::new(false),
                quick_add_loaded: AtomicBool::new(false),
            });

            let handle = app.handle().clone();
            if let Err(e) = tray::create(&handle) {
                log::error!("creating the tray icon failed: {e}");
            }
            let error = apply_shortcut(&handle, shortcut.as_deref());
            *app.state::<AppState>().shortcut_error.lock().unwrap_or_else(|p| p.into_inner()) = error;

            tauri::async_runtime::spawn(async move {
                // The UI shows the window once it has painted; this is a
                // safety net in case the web view fails to load.
                tokio::time::sleep(Duration::from_secs(3)).await;
                if !handle.state::<AppState>().start_hidden {
                    if let Some(w) = handle.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            let _ = w.show();
                        }
                    }
                }
                // Load the quick add window in the background so the
                // shortcut opens it instantly.
                if handle.state::<AppState>().settings().quick_add_shortcut.is_some() {
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        quick_add::prepare(&h);
                    });
                }
                loop {
                    check_reminders(&handle);
                    tokio::time::sleep(Duration::from_secs(10)).await;
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
            prepare_for_update,
            updates_supported,
            update_tasks,
            window_ready,
            hide_quick_add,
            get_settings,
            update_settings,
            suspend_shortcut,
            open_link,
            reminder_action,
            test_notification,
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
