//! Password storage.
//!
//! - Windows: Windows Credential Manager (DPAPI protected, per user).
//! - Linux: the desktop's Secret Service (GNOME Keyring, KWallet, KeePassXC).
//!   Without one, the password goes to a file readable only by the user, and
//!   moves into the keyring as soon as one is available.
//! - Android: a file in the app's private storage, which other apps can't
//!   read.
//! - Elsewhere (development only): that same file.
//!
//! All functions may block (D-Bus, keyring unlock prompts): call them off
//! the main thread.

#![cfg_attr(windows, allow(dead_code))]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SERVICE: &str = "TasksNG";

/// Where a saved password ended up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stored {
    #[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
    Keyring,
    /// No keyring available: a file only the user can read.
    File,
    /// Android: the app's private storage.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    AppStorage,
}

fn account_key(server: &str, username: &str) -> String {
    format!("{username}@{server}")
}

// --- Fallback file -------------------------------------------------------

fn file(dir: &Path) -> PathBuf {
    dir.join("credentials.json")
}
/// Earlier versions used this name on non-Windows systems.
const LEGACY: &str = "dev-secrets.json";

fn read_file(dir: &Path) -> HashMap<String, String> {
    [file(dir), dir.join(LEGACY)]
        .iter()
        .filter_map(|p| std::fs::read(p).ok())
        .filter_map(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok())
        .fold(HashMap::new(), |mut acc, m| {
            for (k, v) in m {
                acc.entry(k).or_insert(v);
            }
            acc
        })
}

fn write_file(dir: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    use std::io::Write;
    let mut dirs = std::fs::DirBuilder::new();
    dirs.recursive(true);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        dirs.mode(0o700);
        // Private from the start, not chmod'ed after writing.
        open.mode(0o600);
    }
    dirs.create(dir).map_err(|e| e.to_string())?;
    let path = file(dir);
    let tmp = path.with_extension("tmp");
    let mut f = open.open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(&serde_json::to_vec(map).unwrap_or_default()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dir.join(LEGACY));
    Ok(())
}

fn forget_file(dir: &Path, key: &str) {
    let mut map = read_file(dir);
    if map.remove(key).is_some() || dir.join(LEGACY).exists() {
        if map.is_empty() {
            let _ = std::fs::remove_file(file(dir));
            let _ = std::fs::remove_file(dir.join(LEGACY));
        } else {
            let _ = write_file(dir, &map);
        }
    }
}

fn save_file(dir: &Path, key: String, password: &str) -> Result<Stored, String> {
    let mut map = read_file(dir);
    map.insert(key, password.to_string());
    write_file(dir, &map).map_err(|e| format!("Could not store the password: {e}"))?;
    Ok(Stored::File)
}

// --- Keyring --------------------------------------------------------------

#[cfg(any(windows, target_os = "linux"))]
fn entry(server: &str, username: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, &account_key(server, username))
}

#[cfg(windows)]
pub fn save(_dir: &Path, server: &str, username: &str, password: &str) -> Result<Stored, String> {
    entry(server, username)
        .and_then(|e| e.set_password(password))
        .map(|()| Stored::Keyring)
        .map_err(|e| format!("Could not store the password: {e}"))
}

#[cfg(target_os = "linux")]
pub fn save(dir: &Path, server: &str, username: &str, password: &str) -> Result<Stored, String> {
    let key = account_key(server, username);
    match entry(server, username).and_then(|e| e.set_password(password)) {
        Ok(()) => {
            forget_file(dir, &key);
            Ok(Stored::Keyring)
        }
        Err(keyring::Error::NoStorageAccess(e)) => {
            Err(format!("Your keyring is locked or refused access ({e}). Unlock it and try again."))
        }
        Err(e) => {
            // No Secret Service on the session bus (e.g. a bare window manager).
            log::warn!("Secret Service unavailable, keeping the password in a private file: {e}");
            save_file(dir, key, password)
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn save(dir: &Path, server: &str, username: &str, password: &str) -> Result<Stored, String> {
    let _ = SERVICE;
    let stored = save_file(dir, account_key(server, username), password)?;
    Ok(if cfg!(target_os = "android") { Stored::AppStorage } else { stored })
}

/// The saved password, if there is one. Fails when the keyring is locked
/// (and stays locked), so people can be told to unlock it.
#[cfg(windows)]
pub fn load(_dir: &Path, server: &str, username: &str) -> Result<Option<String>, String> {
    Ok(entry(server, username).ok().and_then(|e| e.get_password().ok()))
}

#[cfg(target_os = "linux")]
pub fn load(dir: &Path, server: &str, username: &str) -> Result<Option<String>, String> {
    match entry(server, username).and_then(|e| e.get_password()) {
        Ok(p) => return Ok(Some(p)),
        Err(keyring::Error::NoStorageAccess(e)) => {
            log::warn!("keyring locked: {e}");
            return Err("Your keyring is locked. Unlock it, then sync again.".into());
        }
        Err(_) => {}
    }
    let key = account_key(server, username);
    let Some(password) = read_file(dir).remove(&key) else { return Ok(None) };
    // A keyring has appeared since: move the password into it.
    if entry(server, username).and_then(|e| e.set_password(&password)).is_ok() {
        forget_file(dir, &key);
    }
    Ok(Some(password))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn load(dir: &Path, server: &str, username: &str) -> Result<Option<String>, String> {
    Ok(read_file(dir).remove(&account_key(server, username)))
}

pub fn delete(dir: &Path, server: &str, username: &str) {
    #[cfg(any(windows, target_os = "linux"))]
    if let Ok(e) = entry(server, username) {
        let _ = e.delete_credential();
    }
    forget_file(dir, &account_key(server, username));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_file_is_private_and_migrates_legacy() {
        let dir = std::env::temp_dir().join(format!("tasksng-secrets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LEGACY), r#"{"old@srv":"pw1"}"#).unwrap();
        save_file(&dir, "new@srv".into(), "pw2").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(file(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!dir.join(LEGACY).exists());
        let map = read_file(&dir);
        assert_eq!(map.get("old@srv").map(String::as_str), Some("pw1"));
        assert_eq!(map.get("new@srv").map(String::as_str), Some("pw2"));
        forget_file(&dir, "old@srv");
        forget_file(&dir, "new@srv");
        assert!(!file(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
