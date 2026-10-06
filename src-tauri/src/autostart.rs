//! "Start TasksNG when you sign in".
//!
//! Windows uses tauri-plugin-autostart (a registry Run entry). On Linux
//! TasksNG writes the XDG autostart entry itself: the plugin would record
//! `current_exe()`, which for a Nix install is the unwrapped binary inside a
//! store path that disappears after the next update and garbage collection.

#[cfg(all(desktop, not(target_os = "linux")))]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_autostart::ManagerExt;

    pub fn is_enabled(app: &AppHandle) -> bool {
        app.autolaunch().is_enabled().unwrap_or(false)
    }

    pub fn set_enabled(app: &AppHandle, on: bool) -> Result<(), String> {
        let a = app.autolaunch();
        if a.is_enabled().unwrap_or(false) == on {
            return Ok(());
        }
        if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
    }

    pub fn unavailable_reason() -> Option<String> {
        None
    }

    pub fn heal() {}
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::{Path, PathBuf};

    use tauri::AppHandle;

    /// Same file name tauri-plugin-autostart used (the product name).
    const FILE: &str = "TasksNG.desktop";
    const SYSTEM_DIR: &str = "/etc/xdg/autostart";

    fn autostart_dir() -> Option<PathBuf> {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map(|c| c.join("autostart"))
    }

    fn on_path(name: &str) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::env::var_os("PATH").is_some_and(|paths| {
            std::env::split_paths(&paths).any(|d| {
                d.join(name).metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })
        })
    }

    fn quote(p: &Path) -> String {
        let s = p.to_string_lossy();
        if s.chars().any(|c| c.is_whitespace() || "\"'\\$`".contains(c)) {
            format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`"))
        } else {
            s.into_owned()
        }
    }

    /// What `Exec=` should run.
    fn exec_command() -> Result<String, String> {
        if let Some(appimage) = std::env::var_os("APPIMAGE") {
            return Ok(quote(Path::new(&appimage)));
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if exe.starts_with("/nix/store") {
            // A Nix profile puts a stable `tasksng` (the wrapper) on PATH.
            return if on_path("tasksng") {
                Ok("tasksng".into())
            } else {
                Err("Install TasksNG (environment.systemPackages, home.packages or nix profile) to start it at login.".into())
            };
        }
        Ok(quote(&exe))
    }

    fn entry_enabled(path: &Path) -> Option<bool> {
        let text = std::fs::read_to_string(path).ok()?;
        Some(!text.lines().map(str::trim).any(|l| l == "Hidden=true" || l == "X-GNOME-Autostart-enabled=false"))
    }

    pub fn is_enabled(_app: &AppHandle) -> bool {
        let user = autostart_dir().map(|d| d.join(FILE));
        match user.as_deref().and_then(entry_enabled) {
            Some(on) => on,
            // An entry from the NixOS module (programs.tasksng.autostart).
            None => entry_enabled(&Path::new(SYSTEM_DIR).join(FILE)).unwrap_or(false),
        }
    }

    pub fn set_enabled(_app: &AppHandle, on: bool) -> Result<(), String> {
        let dir = autostart_dir().ok_or("No home directory")?;
        let file = dir.join(FILE);
        let system = Path::new(SYSTEM_DIR).join(FILE).exists();
        let text = if on {
            format!(
                "[Desktop Entry]\nType=Application\nName=TasksNG\nComment=Start TasksNG in the background\n\
                 Exec={} --hidden\nIcon=tasksng\nTerminal=false\nStartupNotify=false\nX-GNOME-Autostart-enabled=true\n",
                exec_command()?
            )
        } else if system {
            // A user entry with Hidden=true overrides the system-wide one.
            "[Desktop Entry]\nType=Application\nName=TasksNG\nHidden=true\n".to_string()
        } else {
            return match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(&file, text).map_err(|e| e.to_string())
    }

    pub fn unavailable_reason() -> Option<String> {
        exec_command().err()
    }

    /// Rewrites an entry that points into the Nix store (e.g. written by an
    /// earlier version through tauri-plugin-autostart).
    pub fn heal() {
        let Some(file) = autostart_dir().map(|d| d.join(FILE)) else { return };
        let Ok(text) = std::fs::read_to_string(&file) else { return };
        let stale = text.lines().any(|l| l.starts_with("Exec=/nix/store/") || l.contains(".tasksng-wrapped"));
        if stale && entry_enabled(&file) == Some(true) && exec_command().is_ok() {
            let dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
            let _ = std::fs::create_dir_all(dir);
            if let Ok(exec) = exec_command() {
                let fixed = text
                    .lines()
                    .map(|l| if l.starts_with("Exec=") { format!("Exec={exec} --hidden") } else { l.to_string() })
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = std::fs::write(&file, fixed + "\n");
            }
        }
    }
}

/// Android starts apps itself; reminders are scheduled with the system.
#[cfg(mobile)]
mod imp {
    use tauri::AppHandle;

    pub fn is_enabled(_app: &AppHandle) -> bool {
        false
    }

    pub fn set_enabled(_app: &AppHandle, on: bool) -> Result<(), String> {
        if on {
            Err("not available on this system".into())
        } else {
            Ok(())
        }
    }

    pub fn unavailable_reason() -> Option<String> {
        Some("Not needed on Android: reminders appear without TasksNG running.".into())
    }

    pub fn heal() {}
}

pub use imp::{heal, is_enabled, set_enabled, unavailable_reason};
