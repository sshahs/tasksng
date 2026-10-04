//! App settings that the Rust side needs (the UI keeps its own view
//! preferences in local storage).

use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};

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

/// A change from the UI. Only the fields present are changed, so a change
/// never undoes one made elsewhere (e.g. by the backend) in the meantime.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub close_to_tray: Option<bool>,
    pub reminders: Option<bool>,
    #[serde(deserialize_with = "double_option")]
    pub default_reminder: Option<Option<i64>>,
    #[serde(deserialize_with = "double_option")]
    pub quick_add_shortcut: Option<Option<String>>,
    pub launch_at_login: Option<bool>,
}

fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

impl Settings {
    pub fn apply(&mut self, p: &SettingsPatch) {
        if let Some(v) = p.close_to_tray {
            self.close_to_tray = v;
        }
        if let Some(v) = p.reminders {
            self.reminders = v;
        }
        if let Some(v) = p.default_reminder {
            self.default_reminder = v;
        }
        if let Some(v) = &p.quick_add_shortcut {
            self.quick_add_shortcut = v.clone().filter(|s| !s.trim().is_empty());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_only_what_is_sent() {
        let mut s = Settings { tray_hint_shown: true, ..Settings::default() };
        let p: SettingsPatch = serde_json::from_str(r#"{"reminders":false}"#).unwrap();
        s.apply(&p);
        assert!(!s.reminders);
        assert!(s.tray_hint_shown);
        assert_eq!(s.default_reminder, Some(0));
        let p: SettingsPatch = serde_json::from_str(r#"{"defaultReminder":null,"quickAddShortcut":"Ctrl+Alt+Space"}"#).unwrap();
        s.apply(&p);
        assert_eq!(s.default_reminder, None);
        assert_eq!(s.quick_add_shortcut.as_deref(), Some("Ctrl+Alt+Space"));
        let p: SettingsPatch = serde_json::from_str(r#"{"quickAddShortcut":null}"#).unwrap();
        s.apply(&p);
        assert_eq!(s.quick_add_shortcut, None);
    }
}
