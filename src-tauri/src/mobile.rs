//! Android: reminders are handed to the system's alarm service, so they
//! appear on time while TasksNG isn't running (Android stops apps in the
//! background). The list is rebuilt shortly after every change.
//!
//! Which reminders the system was given is remembered, so the in-app check
//! doesn't show them a second time. Reminders it never got (synced from
//! another device after they were due, for example) are still shown by the
//! in-app check, as on the desktop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use tasks_core::alarms::Upcoming;
use tasks_core::store::write_atomic;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{Action, ActionType, Channel, Importance, NotificationExt, PermissionState, Schedule};

use crate::notify::Toast;
use crate::AppState;

const CHANNEL: &str = "reminders";
const ACTION_TYPE: &str = "reminder";
/// The status bar icon (res/drawable) and its colour. Set on each
/// notification: the plugin takes no `plugins.notification` config, and the
/// app won't start with one.
const ICON: &str = "ic_stat_tasksng";
const ICON_COLOR: &str = "#2563EB";
/// How far ahead reminders are given to the system. Opening TasksNG or
/// changing anything moves the window along.
const HORIZON_DAYS: i64 = 30;
/// Keeps the number of system alarms well below Android's limit (500).
const MAX_SCHEDULED: usize = 150;
/// How long a delivered reminder is remembered.
const KEEP_HOURS: i64 = 48;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    uid: String,
    at: DateTime<Utc>,
    /// Changes when the title or text does, which needs a new alarm.
    sig: u32,
}

pub struct Scheduler {
    path: PathBuf,
    entries: Mutex<HashMap<i32, Entry>>,
    pending: AtomicBool,
    asked_permission: AtomicBool,
}

impl Scheduler {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<i32, Entry>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, entries: &HashMap<i32, Entry>) {
        if let Ok(bytes) = serde_json::to_vec(entries) {
            if let Err(e) = write_atomic(&self.path, &bytes) {
                log::warn!("saving scheduled reminders failed: {e}");
            }
        }
    }
}

/// FNV-1a: notification ids have to be stable across starts.
fn hash(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

fn notification_id(key: &str) -> i32 {
    (hash(key) & 0x7fff_ffff) as i32
}

fn entry_for(u: &Upcoming) -> (i32, Entry) {
    let key = format!("{}@{}", u.reminder.uid, u.at.timestamp());
    let sig = hash(&format!("{}\n{}", u.reminder.title, u.reminder.body));
    (notification_id(&key), Entry { uid: u.reminder.uid.clone(), at: u.at, sig })
}

/// Sets up the notification channel and the Snooze and Done buttons.
pub fn setup(app: &AppHandle, data_dir: &Path) {
    let path = data_dir.join("scheduled-reminders.json");
    let entries = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    app.manage(Scheduler {
        path,
        entries: Mutex::new(entries),
        pending: AtomicBool::new(false),
        asked_permission: AtomicBool::new(false),
    });

    let n = app.notification();
    let channel = Channel::builder(CHANNEL, "Reminders")
        .description("Reminders for your tasks")
        .importance(Importance::High)
        .vibration(true)
        .build();
    if let Err(e) = n.create_channel(channel) {
        log::warn!("creating the notification channel failed: {e}");
    }
    let buttons = ActionType::builder(ACTION_TYPE)
        .actions(vec![
            Action::builder("snooze", "Snooze 10 min").foreground(true).build(),
            Action::builder("done", "Done").foreground(true).build(),
        ])
        .build();
    if let Err(e) = n.register_action_types(vec![buttons]) {
        log::warn!("registering notification buttons failed: {e}");
    }
}

/// Asks for permission to show notifications (Android 13 and later) unless
/// it was answered already. Blocks until people have answered.
fn ensure_permission(app: &AppHandle) -> bool {
    let n = app.notification();
    match n.permission_state() {
        Ok(PermissionState::Granted) => true,
        Ok(PermissionState::Denied) => false,
        _ => matches!(n.request_permission(), Ok(PermissionState::Granted)),
    }
}

/// Shows a notification right away. Blocks: call it off the main thread.
pub fn show(app: &AppHandle, toast: &Toast) -> Result<(), String> {
    if !ensure_permission(app) {
        return Err("Notifications are turned off for TasksNG in Android's settings".into());
    }
    let key = format!("now:{}:{}", toast.reminder_uid.as_deref().unwrap_or_default(), Utc::now().timestamp_millis());
    let mut builder = app
        .notification()
        .builder()
        .id(notification_id(&key))
        .channel_id(CHANNEL)
        .icon(ICON)
        .icon_color(ICON_COLOR)
        .title(&toast.title)
        .body(&toast.body)
        .auto_cancel();
    if let Some(uid) = &toast.reminder_uid {
        builder = builder.action_type_id(ACTION_TYPE).extra("uid", uid);
    } else if let Some(uid) = &toast.open_uid {
        builder = builder.extra("uid", uid);
    }
    builder.show().map_err(|e| e.to_string())
}

/// Whether the system has shown this task's reminder recently, so the
/// in-app check shouldn't.
pub fn delivered_by_system(app: &AppHandle, uid: &str, now: DateTime<Utc>) -> bool {
    let Some(s) = app.try_state::<Scheduler>() else { return false };
    let since = now - Duration::hours(24);
    let delivered = s.entries().values().any(|e| e.uid == uid && e.at <= now && e.at > since);
    delivered
}

/// Brings the system's alarms up to date shortly after a change (bursts of
/// changes are handled once).
pub fn schedule(app: &AppHandle) {
    let Some(s) = app.try_state::<Scheduler>() else { return };
    if s.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(StdDuration::from_secs(1)).await;
        app.state::<Scheduler>().pending.store(false, Ordering::SeqCst);
        let handle = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || reschedule(&handle)).await;
    });
}

fn reschedule(app: &AppHandle) {
    let state = app.state::<AppState>();
    let scheduler = app.state::<Scheduler>();
    let settings = state.settings();
    let now = Utc::now();
    let mut planned = if settings.reminders {
        let store = state.store();
        state.alarms.upcoming(store.tasks(), store.lists(), settings.default_reminder, now, now + Duration::days(HORIZON_DAYS))
    } else {
        Vec::new()
    };
    planned.truncate(MAX_SCHEDULED);
    let n = app.notification();
    // Without permission the system wouldn't show them: leave reminders to
    // the in-app check, which then shows them inside TasksNG.
    let allowed = planned.is_empty()
        || if scheduler.asked_permission.swap(true, Ordering::SeqCst) {
            matches!(n.permission_state(), Ok(PermissionState::Granted))
        } else {
            ensure_permission(app)
        };
    if !allowed {
        planned.clear();
    }
    let wanted: HashMap<i32, (Entry, &Upcoming)> = planned
        .iter()
        .map(|u| {
            let (id, entry) = entry_for(u);
            (id, (entry, u))
        })
        .collect();

    let mut entries = scheduler.entries();
    // Alarms still to come that are no longer wanted (completed, moved …).
    // Ones that went off stay: cancelling would also remove them from the
    // notification shade.
    let stale: Vec<i32> = entries
        .iter()
        .filter(|(id, e)| e.at > now && wanted.get(id).is_none_or(|(w, _)| w != *e))
        .map(|(id, _)| *id)
        .collect();
    if !stale.is_empty() {
        if let Err(e) = n.cancel(stale.clone()) {
            log::warn!("cancelling reminders failed: {e}");
        }
        for id in &stale {
            entries.remove(id);
        }
    }

    for (id, (entry, u)) in &wanted {
        if entries.get(id) == Some(entry) {
            continue;
        }
        let Ok(date) = time::OffsetDateTime::from_unix_timestamp(u.at.timestamp()) else { continue };
        let res = n
            .builder()
            .id(*id)
            .channel_id(CHANNEL)
            .icon(ICON)
            .icon_color(ICON_COLOR)
            .title(&u.reminder.title)
            .body(&u.reminder.body)
            .action_type_id(ACTION_TYPE)
            .extra("uid", &u.reminder.uid)
            .auto_cancel()
            .schedule(Schedule::At { date, repeating: false, allow_while_idle: true })
            .show();
        match res {
            Ok(()) => {
                entries.insert(*id, entry.clone());
            }
            Err(e) => log::warn!("scheduling a reminder failed: {e}"),
        }
    }

    entries.retain(|_, e| e.at > now - Duration::hours(KEEP_HOURS));
    scheduler.save(&entries);
}
