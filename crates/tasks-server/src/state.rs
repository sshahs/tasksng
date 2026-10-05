//! Per-account state and browser sessions.
//!
//! Every Baikal account that signs in gets its own directory under
//! `<data>/users/<id>/` with the same files the desktop app keeps: the task
//! cache, settings, reminder state and the password (readable by this
//! process only). Sessions map a random cookie value to an account.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tasks_core::alarms::Alarms;
use tasks_core::dav::{Credentials, DavClient};
use tasks_core::settings::{self, Settings};
use tasks_core::store::Store;
use tokio::sync::broadcast;
use url::Url;

use crate::Config;

/// Sessions last this long; signing in again starts a new one.
const SESSION_DAYS: i64 = 90;

pub struct Connection {
    pub client: DavClient,
    pub home: Url,
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

impl SyncStatus {
    pub fn signed_out() -> Self {
        SyncStatus { state: "signed-out", message: None, last_sync: None, pending: 0 }
    }
}

/// An event for the account's open browser tabs.
#[derive(Debug, Clone)]
pub struct Event {
    pub name: &'static str,
    pub data: String,
}

/// One Baikal account.
pub struct User {
    pub id: String,
    pub dir: PathBuf,
    pub store: Arc<Mutex<Store>>,
    pub conn: RwLock<Option<Arc<Connection>>>,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub save_lock: tokio::sync::Mutex<()>,
    pub push_pending: AtomicBool,
    pub save_pending: AtomicBool,
    pub status: Mutex<SyncStatus>,
    pub settings: Mutex<Settings>,
    pub alarms: Alarms,
    pub events: broadcast::Sender<Event>,
}

impl User {
    fn open(id: String, dir: PathBuf) -> User {
        let store = Store::open(&dir.join("tasks-cache.json"));
        let mut status = SyncStatus::signed_out();
        let mut conn = None;
        if let Some(account) = store.account() {
            status.last_sync = store.last_sync().map(str::to_string);
            status.pending = store.pending_count();
            match (load_password(&dir), Url::parse(&account.home_url)) {
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
        let settings = settings::load(&dir.join("settings.json"));
        let alarms = Alarms::open(&dir.join("reminders.json"));
        User {
            id,
            dir,
            store: Arc::new(Mutex::new(store)),
            conn: RwLock::new(conn),
            sync_lock: tokio::sync::Mutex::new(()),
            save_lock: tokio::sync::Mutex::new(()),
            push_pending: AtomicBool::new(false),
            save_pending: AtomicBool::new(false),
            status: Mutex::new(status),
            settings: Mutex::new(settings),
            alarms,
            events: broadcast::channel(64).0,
        }
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn save_settings(&self, s: &Settings) {
        settings::save(&self.dir.join("settings.json"), s);
        *self.settings.lock().unwrap_or_else(|p| p.into_inner()) = s.clone();
    }

    pub fn connection(&self) -> Option<Arc<Connection>> {
        self.conn.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_connection(&self, conn: Option<Connection>) {
        *self.conn.write().unwrap_or_else(|p| p.into_inner()) = conn.map(Arc::new);
    }

    pub fn status(&self) -> SyncStatus {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Sends an event to every open tab of this account.
    pub fn emit<T: Serialize>(&self, name: &'static str, data: &T) {
        if let Ok(data) = serde_json::to_string(data) {
            let _ = self.events.send(Event { name, data });
        }
    }

    pub fn save_password(&self, password: &str) -> std::io::Result<()> {
        write_private(&self.dir.join("credentials.json"), &serde_json::to_vec(&StoredPassword { password: password.into() })?)
    }

    pub fn forget_password(&self) {
        let _ = std::fs::remove_file(self.dir.join("credentials.json"));
    }
}

#[derive(Serialize, Deserialize)]
struct StoredPassword {
    password: String,
}

fn load_password(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join("credentials.json")).ok()?;
    serde_json::from_slice::<StoredPassword>(&bytes).ok().map(|s| s.password)
}

/// Writes a file only this user can read, created that way from the start.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let tmp = path.with_extension("tmp");
    let mut f = open.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// The directory name for an account: the same Baikal user always gets the
/// same one, and the name reveals nothing about it. `server` is the address
/// signed in to: the home URL alone is whatever that server reports, so with
/// TASKSNG_ALLOW_ANY_SERVER another server could claim someone else's.
pub fn user_id(server: &str, home_url: &str, username: &str) -> String {
    let digest = Sha256::digest(format!("{server}\n{home_url}\n{username}").as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRecord {
    user: String,
    expires: DateTime<Utc>,
}

/// Browser sessions. Only a hash of each cookie value is stored.
pub struct Sessions {
    path: PathBuf,
    map: HashMap<String, SessionRecord>,
}

impl Sessions {
    fn open(path: PathBuf) -> Sessions {
        let mut map: HashMap<String, SessionRecord> =
            std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let now = Utc::now();
        map.retain(|_, s| s.expires > now);
        Sessions { path, map }
    }

    fn save(&self) {
        match serde_json::to_vec(&self.map) {
            Ok(bytes) => {
                if let Err(e) = write_private(&self.path, &bytes) {
                    log::error!("saving sessions failed: {e}");
                }
            }
            Err(e) => log::error!("serializing sessions failed: {e}"),
        }
    }

    fn hash(token: &str) -> String {
        Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Starts a session and returns the cookie value.
    pub fn create(&mut self, user: &str) -> String {
        let mut bytes = [0u8; 32];
        rand::fill(&mut bytes);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let expires = Utc::now() + Duration::days(SESSION_DAYS);
        self.map.insert(Self::hash(&token), SessionRecord { user: user.into(), expires });
        self.save();
        token
    }

    pub fn user_of(&self, token: &str) -> Option<String> {
        self.map.get(&Self::hash(token)).filter(|s| s.expires > Utc::now()).map(|s| s.user.clone())
    }

    pub fn remove(&mut self, token: &str) {
        if self.map.remove(&Self::hash(token)).is_some() {
            self.save();
        }
    }

    /// Signs the account out everywhere.
    pub fn remove_user(&mut self, user: &str) {
        let before = self.map.len();
        self.map.retain(|_, s| s.user != user);
        if self.map.len() != before {
            self.save();
        }
    }
}

pub struct AppState {
    pub config: Config,
    pub sessions: Mutex<Sessions>,
    users: Mutex<HashMap<String, Arc<User>>>,
}

impl AppState {
    pub fn new(config: Config) -> std::io::Result<AppState> {
        std::fs::create_dir_all(config.data_dir.join("users"))?;
        let sessions = Sessions::open(config.data_dir.join("sessions.json"));
        Ok(AppState { config, sessions: Mutex::new(sessions), users: Mutex::new(HashMap::new()) })
    }

    pub fn sessions(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The account's state, loaded from disk the first time it is needed.
    pub fn user(&self, id: &str) -> std::io::Result<Arc<User>> {
        let mut users = self.users.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(u) = users.get(id) {
            return Ok(u.clone());
        }
        let dir = self.config.data_dir.join("users").join(id);
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let user = Arc::new(User::open(id.to_string(), dir));
        users.insert(id.to_string(), user.clone());
        Ok(user)
    }

    pub fn loaded_users(&self) -> Vec<Arc<User>> {
        self.users.lock().unwrap_or_else(|p| p.into_inner()).values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_store_only_hashes_and_expire() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let mut s = Sessions::open(path.clone());
        let token = s.create("abc");
        assert_eq!(s.user_of(&token).as_deref(), Some("abc"));
        assert_eq!(s.user_of("nope"), None);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&token));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Reloaded from disk.
        let s2 = Sessions::open(path.clone());
        assert_eq!(s2.user_of(&token).as_deref(), Some("abc"));
        s.remove_user("abc");
        assert_eq!(Sessions::open(path).user_of(&token), None);
    }

    #[test]
    fn user_ids_are_stable_and_distinct() {
        let home = "https://dav.example.com/dav.php/calendars/a/";
        let a = user_id("https://dav.example.com/", home, "a");
        assert_eq!(a, user_id("https://dav.example.com/", home, "a"));
        assert_ne!(a, user_id("https://dav.example.com/", home, "b"));
        // Another server reporting the same home URL is another account.
        assert_ne!(a, user_id("https://evil.example.net/", home, "a"));
        assert_eq!(a.len(), 32);
    }
}
