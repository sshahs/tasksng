//! Tauri shell: exposes the task store to the UI and runs synchronisation in
//! the background so every UI action completes instantly.

mod autostart;
#[cfg(desktop)]
mod cli;
mod desktop;
#[cfg(mobile)]
mod mobile;
mod notify;
#[cfg(desktop)]
mod quick_add;
mod secrets;
#[cfg(desktop)]
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use notify::{Toast, ToastAction};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tasks_core::settings::{self, Settings, SettingsPatch};
use tasks_core::alarms::{Alarms, DueReminder};
use tasks_core::dav::{normalize_url, Credentials, DavClient};
use tasks_core::model::{NewTask, PatchOutcome, Task, TaskPatch, TaskStatus};
use tasks_core::store::{write_atomic, Account, Snapshot, Store, TaskList};
use tasks_core::sync::{self, SyncReport};
use tasks_core::Error;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
#[cfg(desktop)]
use tauri::WindowEvent;
#[cfg(desktop)]
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
    /// Started at login (`--hidden`) or for quick add: keep the main window hidden.
    start_hidden: bool,
    /// Becomes true once the saved password has been read (the keyring can
    /// take a while, e.g. while it asks to be unlocked).
    creds_loaded: tokio::sync::watch::Sender<bool>,
    creds_retry: Mutex<Option<std::time::Instant>>,
    tray_created: bool,
    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) quick_add_pending: AtomicBool,
    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) quick_add_loaded: AtomicBool,
    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) quick_add_creating: AtomicBool,
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
    reminders_changed(app);
}

/// Tasks or reminder settings changed. On Android the reminders the system
/// shows are scheduled again; the desktop checks every few seconds anyway.
fn reminders_changed(app: &AppHandle) {
    #[cfg(mobile)]
    mobile::schedule(app);
    #[cfg(desktop)]
    let _ = app;
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
    reminders_changed(app);
    let current = app.state::<AppState>().status.lock().unwrap_or_else(|p| p.into_inner()).clone();
    set_status(app, current.state, current.message);
}

pub(crate) async fn run_sync(app: &AppHandle, state: &AppState) -> Result<Vec<String>, Error> {
    let mut loaded = state.creds_loaded.subscribe();
    let _ = tokio::time::timeout(Duration::from_secs(120), loaded.wait_for(|l| *l)).await;
    if state.connection().is_none() && state.store().account().is_some() && retry_credentials(state) {
        // E.g. the keyring was locked at start-up and has been unlocked since.
        let handle = app.clone();
        if let Ok((s, msg)) = tauri::async_runtime::spawn_blocking(move || connect_saved(&handle.state::<AppState>())).await {
            if s != "idle" {
                set_status(app, s, msg.clone());
                return Err(Error::Other(msg.unwrap_or_else(|| "Please sign in again".into())));
            }
        }
    }
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

    let stored = {
        let (dir, home_url, user, password) =
            (state.data_dir.clone(), discovery.home_url.clone(), username.clone(), args.password.clone());
        tauri::async_runtime::spawn_blocking(move || secrets::save(&dir, &home_url, &user, &password))
            .await
            .map_err(|e| e.to_string())??
    };
    let replaced = {
        let mut store = state.store();
        let replaced = store
            .account()
            .filter(|old| old.home_url != discovery.home_url || old.username != username)
            .map(|old| (old.home_url.clone(), old.username.clone()));
        store.set_account(Account {
            server_url: args.server_url.trim().to_string(),
            username,
            principal_url: discovery.principal_url,
            home_url: discovery.home_url,
            accept_invalid_certs: args.accept_invalid_certs,
        });
        replaced
    };
    if let Some((home_url, user)) = replaced {
        let dir = state.data_dir.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || secrets::delete(&dir, &home_url, &user)).await;
    }
    state.set_connection(Some(Connection { client, home }));
    state.creds_loaded.send_replace(true);
    let (mut notices, error) = match run_sync(&app, &state).await {
        Ok(n) => (n, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    if stored == secrets::Stored::File {
        notices.push(
            "No keyring (Secret Service) was found, so your password is kept in a file only you can read. \
             It moves into the keyring once one is running."
                .into(),
        );
    }
    Ok(SyncOutcome { snapshot: state.store().snapshot(), notices, error })
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppState>) -> Result<Snapshot, String> {
    let _guard = state.sync_lock.lock().await;
    state.set_connection(None);
    let account = {
        let mut store = state.store();
        let account = store.account().map(|a| (a.home_url.clone(), a.username.clone()));
        store.sign_out();
        account
    };
    if let Some((home_url, username)) = account {
        let dir = state.data_dir.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || secrets::delete(&dir, &home_url, &username)).await;
    }
    set_status(&app, "signed-out", None);
    schedule_save(&app);
    reminders_changed(&app);
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
/// installer and end up as a second, installed copy. Linux copies are
/// updated by their package manager (Nix, …).
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
        false
    }
}

/// The main window's page has painted; show it unless TasksNG was started
/// with Windows into the notification area.
#[tauri::command]
fn window_ready(app: AppHandle, window: tauri::Window, state: State<'_, AppState>) {
    match window.label() {
        "main" if !state.start_hidden => show_main_window(&app),
        #[cfg(desktop)]
        quick_add::LABEL => quick_add::ready(&app),
        _ => {}
    }
}

#[tauri::command]
fn hide_quick_add(app: AppHandle) {
    #[cfg(desktop)]
    quick_add::hide(&app);
    #[cfg(mobile)]
    let _ = app;
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
    /// Reminders appear as system notifications (otherwise inside the app).
    native_notifications: bool,
    platform: Platform,
}

/// What the system TasksNG runs on supports, so Settings can say the right
/// thing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Platform {
    /// `windows`, `linux`, `macos`, `android`
    os: &'static str,
    /// `windows`, `nix`, `appimage`, `android` or `system`
    install_kind: &'static str,
    /// Global shortcuts can't be registered (Wayland).
    wayland: bool,
    /// A tray icon is shown somewhere.
    tray: bool,
    /// Notifications can have Snooze and Done buttons.
    notification_actions: bool,
    /// Why "start at login" can't be turned on, if it can't.
    autostart_error: Option<String>,
}

/// Talks to D-Bus on Linux: call it off the main thread.
fn settings_view(app: &AppHandle) -> SettingsView {
    let state = app.state::<AppState>();
    let shortcut_error = state.shortcut_error.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let (notifications, notification_actions) = notify::capabilities();
    SettingsView {
        settings: state.settings(),
        launch_at_login: autostart::is_enabled(app),
        shortcut_error,
        native_notifications: notifications,
        platform: Platform {
            os: std::env::consts::OS,
            install_kind: desktop::install_kind(),
            wayland: desktop::wayland_session(),
            tray: tray_visible(&state),
            notification_actions,
            autostart_error: autostart::unavailable_reason(),
        },
    }
}

/// Whether the tray icon can actually be seen (GNOME has no tray without an
/// extension). Panels can start after TasksNG, so this is checked each time.
fn tray_visible(state: &AppState) -> bool {
    state.tray_created && desktop::tray_host_present()
}

/// Registers the quick add shortcut; returns a message if that failed.
#[cfg(mobile)]
fn apply_shortcut(_app: &AppHandle, _shortcut: Option<&str>) -> Option<String> {
    None
}

/// Registers the quick add shortcut; returns a message if that failed.
#[cfg(desktop)]
fn apply_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Option<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let shortcut = shortcut.map(str::trim).filter(|s| !s.is_empty())?;
    if desktop::wayland_session() {
        // Registering "works" but the keys never arrive.
        return Some(
            "Apps can't set global shortcuts on Wayland. Add a keyboard shortcut in your desktop's settings that runs: tasksng --quick-add"
                .into(),
        );
    }
    match gs.register(shortcut) {
        Ok(()) => None,
        Err(e) => {
            log::warn!("registering {shortcut} failed: {e}");
            Some(if cfg!(windows) {
                format!("{} is already used by Windows or another app. Pick a different shortcut.", shortcut.replace("Super", "Win"))
            } else {
                format!("{shortcut} is already used by your desktop or another app. Pick a different shortcut.")
            })
        }
    }
}

/// Whether the quick add shortcut is set up and working.
#[cfg(desktop)]
fn shortcut_active(state: &AppState) -> bool {
    state.settings().quick_add_shortcut.is_some() && state.shortcut_error.lock().unwrap_or_else(|p| p.into_inner()).is_none()
}

#[tauri::command(async)]
fn get_settings(app: AppHandle) -> SettingsView {
    settings_view(&app)
}

#[tauri::command(async)]
fn update_settings(app: AppHandle, state: State<'_, AppState>, patch: SettingsPatch) -> Result<SettingsView, String> {
    let (old, new) = {
        let mut current = state.settings.lock().unwrap_or_else(|p| p.into_inner());
        let old = current.clone();
        current.apply(&patch);
        (old, current.clone())
    };
    settings::save(&state.settings_path, &new);
    if old.quick_add_shortcut != new.quick_add_shortcut {
        let error = apply_shortcut(&app, new.quick_add_shortcut.as_deref());
        *state.shortcut_error.lock().unwrap_or_else(|p| p.into_inner()) = error;
        #[cfg(desktop)]
        if shortcut_active(&state) {
            quick_add::prepare(&app);
        }
    }
    if new.reminders && !old.reminders {
        state.alarms.restart();
    }
    if (new.reminders, new.default_reminder) != (old.reminders, old.default_reminder) {
        reminders_changed(&app);
    }
    if let Some(launch) = patch.launch_at_login {
        autostart::set_enabled(&app, launch).map_err(|e| format!("Couldn't change the start-up setting: {e}"))?;
    }
    Ok(settings_view(&app))
}

/// Pauses the global shortcut while a new one is being recorded in
/// Settings (otherwise pressing the current one would open quick add).
#[tauri::command]
fn suspend_shortcut(app: AppHandle, state: State<'_, AppState>, suspend: bool) {
    #[cfg(mobile)]
    let _ = (app, state, suspend);
    #[cfg(desktop)]
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

#[cfg(desktop)]
fn app_id(app: &AppHandle) -> String {
    app.config().identifier.clone()
}

#[cfg(desktop)]
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
        ToastAction::Snooze(uid, minutes) => {
            state.alarms.snooze(&uid, minutes);
            reminders_changed(app);
        }
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
    let summary = toasts.len() == 1 && due.len() > 1;
    show_toasts(app, toasts, move |handle, failed| {
        if failed.is_empty() {
            return;
        }
        // Shown inside the app instead: only the ones that failed.
        let missed: Vec<&DueReminder> = if summary {
            due.iter().collect()
        } else {
            due.iter().filter(|d| failed.iter().any(|t| t.reminder_uid.as_deref() == Some(d.uid.as_str()))).collect()
        };
        show_main_window(handle);
        let _ = handle.emit_to("main", "reminders", &missed);
    });
}

/// Shows notifications and reports the ones that couldn't be shown. Windows
/// wants that on the main thread; on Linux it's blocking D-Bus calls.
fn show_toasts(app: &AppHandle, toasts: Vec<Toast>, done: impl FnOnce(&AppHandle, Vec<Toast>) + Send + 'static) {
    let handle = app.clone();
    let work = move || {
        let failed: Vec<Toast> = toasts
            .into_iter()
            .filter(|t| show_toast(&handle, t).inspect_err(|e| log::info!("notification not shown: {e}")).is_err())
            .collect();
        done(&handle, failed);
    };
    if cfg!(windows) {
        if let Err(e) = app.run_on_main_thread(work) {
            log::warn!("showing notifications failed: {e}");
        }
    } else {
        std::thread::spawn(work);
    }
}

fn show_toast(app: &AppHandle, toast: &Toast) -> Result<(), String> {
    #[cfg(desktop)]
    {
        notify::show(&app_id(app), toast, toast_handler(app))
    }
    #[cfg(mobile)]
    {
        mobile::show(app, toast)
    }
}

fn check_reminders(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.reminders {
        return;
    }
    let now = chrono::Utc::now();
    #[cfg_attr(desktop, allow(unused_mut))]
    let mut due = {
        let store = state.store();
        state.alarms.collect(store.tasks(), store.lists(), settings.default_reminder, now)
    };
    // The system showed the ones it was given (see mobile.rs).
    #[cfg(mobile)]
    due.retain(|d| !mobile::delivered_by_system(app, &d.uid, now));
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
async fn test_notification(app: AppHandle) -> Result<(), String> {
    let toast = Toast {
        title: "This is how reminders look".into(),
        body: "Snooze or complete tasks right from the notification.".into(),
        reminder_uid: Some(String::new()),
        open_uid: None,
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    show_toasts(&app, vec![toast], move |_, failed| {
        let _ = tx.send(failed.is_empty());
    });
    match rx.await {
        Ok(true) => Ok(()),
        _ if cfg!(mobile) => Err("Notifications are turned off for TasksNG. Allow them in Android's settings.".into()),
        _ => Err("No notification service answered. Is a notification daemon running?".into()),
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------

pub(crate) fn show_main_window(app: &AppHandle) {
    #[cfg(mobile)]
    let _ = app;
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Closing the main window hides it to the notification area (once with a
/// hint), unless that is turned off.
#[cfg(desktop)]
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
                let tray = cfg!(windows) || tray_visible(&state);
                let body = if cfg!(windows) {
                    "It stays in the notification area so reminders can appear. Right-click its icon to quit, or change this in Settings."
                } else if tray {
                    "It keeps running so reminders can appear. Quit from its tray icon, or change this in Settings."
                } else {
                    "It keeps running so reminders can appear. Open it again from your app launcher and quit with Ctrl+Q, or change this in Settings."
                };
                let toast = Toast { title: "TasksNG is still running".into(), body: body.into(), reminder_uid: None, open_uid: None };
                show_toasts(app, vec![toast], |handle, failed| {
                    // Nothing could tell people where it went: bring it back.
                    if !failed.is_empty() && !cfg!(windows) {
                        show_main_window(handle);
                    }
                });
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

/// Acts on flags given to this process or forwarded from a second launch.
#[cfg(desktop)]
fn handle_cli(app: &AppHandle, cli: &cli::Cli, first_launch: bool) {
    if cli.quit {
        app.exit(0);
        return;
    }
    if cli.quick_add {
        quick_add::show(app);
    }
    if cli.show || (!first_launch && !cli.hidden && !cli.quick_add && !cli.sync) {
        show_main_window(app);
    }
    if cli.sync {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let _ = run_sync(&app, &state).await;
        });
    }
}

/// Reads the saved password and connects. The keyring may block (D-Bus, an
/// unlock prompt): call it off the main thread. Returns the status to show.
fn connect_saved(state: &AppState) -> (&'static str, Option<String>) {
    let Some(account) = state.store().account().cloned() else { return ("signed-out", None) };
    let password = match secrets::load(&state.data_dir, &account.home_url, &account.username) {
        Ok(p) => p,
        Err(locked) => return ("auth-required", Some(locked)),
    };
    match (password, Url::parse(&account.home_url)) {
        (Some(password), Ok(home)) => {
            let creds = Credentials { username: account.username.clone(), password };
            match DavClient::new(&home, creds, account.accept_invalid_certs) {
                Ok(client) => {
                    // Signed in again meanwhile: keep that connection.
                    if state.connection().is_none() {
                        state.set_connection(Some(Connection { client, home }));
                    }
                    ("idle", None)
                }
                Err(e) => ("error", Some(e.to_string())),
            }
        }
        _ => ("auth-required", Some("Please sign in again".to_string())),
    }
}

/// Whether to read the keyring again (at most every few minutes: a locked
/// keyring asks to be unlocked each time).
fn retry_credentials(state: &AppState) -> bool {
    let mut last = state.creds_retry.lock().unwrap_or_else(|p| p.into_inner());
    if last.is_some_and(|t| t.elapsed() < Duration::from_secs(300)) {
        return false;
    }
    *last = Some(std::time::Instant::now());
    true
}

fn load_credentials(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let (status, message) = connect_saved(&state);
        if state.connection().is_none() || status != "idle" {
            set_status(&app, status, message);
        }
        state.creds_loaded.send_replace(true);
    });
}

fn log_environment(state: &AppState) {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    let (notifications, actions) = notify::capabilities();
    log::info!(
        "TasksNG on {} ({}): session {:?}, desktop {:?}, tray {}, notifications {} (buttons {})",
        std::env::consts::OS,
        desktop::install_kind(),
        var("XDG_SESSION_TYPE"),
        var("XDG_CURRENT_DESKTOP"),
        tray_visible(state),
        notifications,
        actions,
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before anything touches the display, D-Bus or $HOME.
    #[cfg(desktop)]
    let cli = match cli::Cli::from_env() {
        Ok(cli) => cli,
        Err(cli::Early::Version) => {
            println!("TasksNG {}", context.package_info().version);
            return;
        }
        Err(cli::Early::Help) => {
            print!("{}", cli::HELP);
            return;
        }
    };
    #[cfg(desktop)]
    let first_cli = cli.clone();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        // A second launch hands over its flags, e.g. `tasksng --quick-add`.
        match cli::Cli::parse(&args) {
            Ok(cli) => handle_cli(app, &cli, false),
            Err(_) => show_main_window(app),
        }
    }));
    let builder = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("zbus", log::LevelFilter::Warn)
                .level_for("tracing", log::LevelFilter::Warn)
                .max_file_size(2_000_000)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(all(desktop, not(target_os = "linux")))]
    let builder = builder.plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        // Not on the hotkey thread: on X11 that thread is
                        // what (un)registering waits for on the main thread.
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || quick_add::toggle(&handle));
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
        .on_window_event(on_window_event);
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let app = builder
        .setup(move |app| {
            #[cfg(desktop)]
            let cli = first_cli;
            let data_dir = app.path().app_data_dir()?;
            let store = Store::open(&data_dir.join("tasks-cache.json"));
            let settings_path = data_dir.join("settings.json");
            let settings = settings::load(&settings_path);
            let mut status = SyncStatus { state: "signed-out", message: None, last_sync: None, pending: 0 };
            let signed_in = store.account().is_some();
            if signed_in {
                status.state = "idle";
                status.last_sync = store.last_sync().map(str::to_string);
                status.pending = store.pending_count();
            }
            let shortcut = settings.quick_add_shortcut.clone();
            notify::register(&app.config().identifier, &data_dir);
            autostart::heal();
            let handle = app.handle().clone();

            // tray-icon aborts the process if it can't load AppIndicator.
            #[cfg(desktop)]
            let tray_created = desktop::tray_library_available()
                && tray::create(&handle).inspect_err(|e| log::error!("creating the tray icon failed: {e}")).is_ok();
            #[cfg(desktop)]
            if !tray_created {
                log::warn!("no tray icon: AppIndicator library not found");
            }
            #[cfg(mobile)]
            let tray_created = false;
            #[cfg(desktop)]
            let start_hidden = cli.hidden || cli.quick_add;
            #[cfg(mobile)]
            let start_hidden = false;
            #[cfg(mobile)]
            mobile::setup(&handle, &data_dir);

            app.manage(AppState {
                alarms: Alarms::open(&data_dir.join("reminders.json")),
                data_dir,
                store: Arc::new(Mutex::new(store)),
                conn: RwLock::new(None),
                sync_lock: tokio::sync::Mutex::new(()),
                save_lock: tokio::sync::Mutex::new(()),
                push_pending: AtomicBool::new(false),
                save_pending: AtomicBool::new(false),
                status: Mutex::new(status),
                settings_path,
                settings: Mutex::new(settings),
                shortcut_error: Mutex::new(None),
                start_hidden,
                creds_loaded: tokio::sync::watch::channel(!signed_in).0,
                // The start-up read counts as an attempt.
                creds_retry: Mutex::new(Some(std::time::Instant::now())),
                tray_created,
                quick_add_pending: AtomicBool::new(false),
                quick_add_loaded: AtomicBool::new(false),
                quick_add_creating: AtomicBool::new(false),
            });
            if signed_in {
                load_credentials(handle.clone());
            }

            let error = apply_shortcut(&handle, shortcut.as_deref());
            *app.state::<AppState>().shortcut_error.lock().unwrap_or_else(|p| p.into_inner()) = error;
            #[cfg(desktop)]
            handle_cli(&handle, &cli, true);

            #[cfg(all(unix, desktop))]
            {
                // Logging out or `systemctl stop` sends SIGTERM: save first.
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()))
                    else {
                        return;
                    };
                    tokio::select! {
                        _ = term.recv() => {}
                        _ = int.recv() => {}
                    }
                    handle.exit(0);
                });
            }

            tauri::async_runtime::spawn(async move {
                {
                    let h = handle.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || log_environment(&h.state::<AppState>())).await;
                }
                #[cfg(desktop)]
                {
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
                    if shortcut_active(&handle.state::<AppState>()) {
                        quick_add::prepare(&handle);
                    }
                }
                // Moves the window of reminders given to the system along.
                reminders_changed(&handle);
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
            quit_app,
        ])
        .build(context)
        .expect("error while building TasksNG");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            notify::close_all();
            if let Some(state) = handle.try_state::<AppState>() {
                let _guard = state.save_lock.blocking_lock();
                if let Err(e) = state.store().save_now() {
                    log::error!("saving cache on exit failed: {e}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    /// Plugins built with `init()` take no config: a `plugins.<name>` entry
    /// for one of them stops the app at startup ("invalid type: map,
    /// expected unit"). These are the ones on Android.
    #[test]
    fn plugins_without_config_have_none() {
        for file in ["tauri.conf.json", "tauri.android.conf.json"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
            let config: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            for plugin in ["notification", "process", "opener", "log"] {
                assert!(config["plugins"][plugin].is_null(), "{file} configures the {plugin} plugin, which takes no config");
            }
        }
    }
}
