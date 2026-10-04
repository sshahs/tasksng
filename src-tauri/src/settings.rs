//! App settings that the Rust side needs (the UI keeps its own view
//! preferences in local storage).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Win+Alt+N: free on a standard Windows installation and independent of
/// the keyboard layout (unlike Ctrl+Alt, which is AltGr on many layouts).
pub const DEFAULT_SHORTCUT: &str = "Super+Alt+N";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Closing the window keeps TasksNG running in the notification area.
    pub close_to_tray: bool,
    /// Show reminders as Windows notifications.
    pub reminders: bool,
    /// Seconds relative to the due time for tasks with a due time but no
    /// reminder of their own; `None` turns this off.
    pub default_reminder: Option<i64>,
    /// Global shortcut for quick add; `None` turns it off.
    pub quick_add_shortcut: Option<String>,
    /// The "still running in the notification area" hint was shown.
    pub tray_hint_shown: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            close_to_tray: true,
            reminders: true,
            default_reminder: Some(0),
            quick_add_shortcut: Some(DEFAULT_SHORTCUT.to_string()),
            tray_hint_shown: false,
        }
    }
}

pub fn load(path: &Path) -> Settings {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) {
    match serde_json::to_vec_pretty(settings) {
        Ok(bytes) => {
            if let Err(e) = tasks_core::store::write_atomic(path, &bytes) {
                log::error!("saving settings failed: {e}");
            }
        }
        Err(e) => log::error!("serializing settings failed: {e}"),
    }
}
