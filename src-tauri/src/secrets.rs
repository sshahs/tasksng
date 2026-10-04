//! Password storage.
//!
//! On Windows the password lives in the Windows Credential Manager (DPAPI
//! protected, per user). Other platforms are only used for development and
//! keep it in a file next to the cache.

const SERVICE: &str = "TasksNG";

fn account_key(server: &str, username: &str) -> String {
    format!("{username}@{server}")
}

#[cfg(windows)]
mod imp {
    use super::*;

    fn entry(server: &str, username: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, &account_key(server, username)).map_err(|e| e.to_string())
    }

    pub fn save(_dir: &std::path::Path, server: &str, username: &str, password: &str) -> Result<(), String> {
        entry(server, username)?.set_password(password).map_err(|e| format!("Could not store the password: {e}"))
    }

    pub fn load(_dir: &std::path::Path, server: &str, username: &str) -> Option<String> {
        entry(server, username).ok()?.get_password().ok()
    }

    pub fn delete(_dir: &std::path::Path, server: &str, username: &str) {
        if let Ok(e) = entry(server, username) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn file(dir: &Path) -> PathBuf {
        dir.join("dev-secrets.json")
    }

    fn read(dir: &Path) -> HashMap<String, String> {
        std::fs::read(file(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write(dir: &Path, map: &HashMap<String, String>) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = file(dir);
        std::fs::write(&path, serde_json::to_vec(map).unwrap_or_default()).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn save(dir: &Path, server: &str, username: &str, password: &str) -> Result<(), String> {
        let _ = SERVICE;
        let mut map = read(dir);
        map.insert(account_key(server, username), password.to_string());
        write(dir, &map)
    }

    pub fn load(dir: &Path, server: &str, username: &str) -> Option<String> {
        read(dir).remove(&account_key(server, username))
    }

    pub fn delete(dir: &Path, server: &str, username: &str) {
        let mut map = read(dir);
        if map.remove(&account_key(server, username)).is_some() {
            let _ = write(dir, &map);
        }
    }
}

pub use imp::{delete, load, save};
