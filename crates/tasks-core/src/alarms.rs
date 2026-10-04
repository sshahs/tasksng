//! Decides when reminders go off. Covers reminders set in TasksNG and in
//! other apps (they are the same `VALARM`s), plus an optional automatic
//! reminder for tasks that have a due time.
//!
//! Which reminders were already shown, and snoozes, are kept on this PC only:
//! acknowledging them on the server would mean a write per reminder.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Duration, Local, Utc};
use serde::{Deserialize, Serialize};
use crate::dates::IcalTime;
use crate::model::Task;
use crate::store::{write_atomic, TaskList};

/// Reminders missed while TasksNG wasn't running are still shown if they
/// are at most this old.
const MISSED_WINDOW_HOURS: i64 = 24;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlarmState {
    /// Nothing that was due before this moment is shown (no flood of old
    /// reminders on first start or after turning reminders on).
    pub since: Option<DateTime<Utc>>,
    /// Reminders already shown: key → when they were due.
    pub fired: HashMap<String, DateTime<Utc>>,
    /// Snoozed tasks (by UID) and when to remind again.
    pub snoozed: HashMap<String, DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub uid: String,
    pub id: String,
    pub title: String,
    pub body: String,
}

pub struct Alarms {
    path: PathBuf,
    state: Mutex<AlarmState>,
}

impl Alarms {
    pub fn open(path: &Path) -> Self {
        let state = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Alarms { path: path.to_path_buf(), state: Mutex::new(state) }
    }

    fn with<R>(&self, f: impl FnOnce(&mut AlarmState) -> (R, bool)) -> R {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let (out, changed) = f(&mut state);
        if changed {
            if let Ok(bytes) = serde_json::to_vec(&*state) {
                if let Err(e) = write_atomic(&self.path, &bytes) {
                    log::warn!("saving reminder state failed: {e}");
                }
            }
        }
        out
    }

    pub fn snooze(&self, uid: &str, minutes: u32) {
        let until = Utc::now() + Duration::minutes(minutes.clamp(1, 7 * 24 * 60) as i64);
        self.with(|s| ((), s.snoozed.insert(uid.to_string(), until) != Some(until)));
    }

    /// Called when reminders are switched on: start from now.
    pub fn restart(&self) {
        self.with(|s| {
            s.since = Some(Utc::now());
            ((), true)
        });
    }

    pub fn collect<'a>(
        &self,
        tasks: impl Iterator<Item = &'a Task>,
        lists: &[TaskList],
        default_reminder: Option<i64>,
        now: DateTime<Utc>,
    ) -> Vec<DueReminder> {
        self.with(|s| {
            let before = (s.since, s.fired.len(), s.snoozed.len());
            let due = collect(tasks, lists, s, default_reminder, now);
            let changed = !due.is_empty() || before != (s.since, s.fired.len(), s.snoozed.len());
            (due, changed)
        })
    }
}

fn timed_due(task: &Task) -> Option<DateTime<Utc>> {
    let due = IcalTime::parse_ui(task.due.as_deref()?)?;
    (!due.is_date()).then(|| due.instant())
}

/// When `task`'s reminders go off.
pub fn fire_times(task: &Task, default_reminder: Option<i64>) -> Vec<DateTime<Utc>> {
    if !task.reminders.is_empty() {
        return task.reminders.iter().filter_map(|r| r.fire_time(task)).collect();
    }
    match (default_reminder, timed_due(task)) {
        (Some(offset), Some(due)) => vec![due + Duration::seconds(offset)],
        _ => Vec::new(),
    }
}

/// Finds the reminders that are due now and records them as shown.
pub fn collect<'a>(
    tasks: impl Iterator<Item = &'a Task>,
    lists: &[TaskList],
    state: &mut AlarmState,
    default_reminder: Option<i64>,
    now: DateTime<Utc>,
) -> Vec<DueReminder> {
    let since = *state.since.get_or_insert(now);
    let earliest = since.max(now - Duration::hours(MISSED_WINDOW_HOURS));
    let open: Vec<&Task> = tasks.filter(|t| !t.completed).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for t in &open {
        // A reminder that was already in the past when the task was last
        // edited (e.g. a task created for 9:00 at 9:05) is not news.
        let edited = t.modified.as_deref().and_then(IcalTime::parse_ui).map(IcalTime::instant);
        let mut hit = false;
        for at in fire_times(t, default_reminder) {
            if at > now || at < earliest || edited.is_some_and(|e| at < e) {
                continue;
            }
            if state.fired.insert(format!("{}@{}", t.uid, at.timestamp()), at).is_none() {
                hit = true;
            }
        }
        if hit && seen.insert(t.uid.clone()) {
            out.push(describe(t, lists, now));
        }
    }
    let woke: Vec<String> = state.snoozed.iter().filter(|(_, until)| **until <= now).map(|(u, _)| u.clone()).collect();
    for uid in woke {
        state.snoozed.remove(&uid);
        if let Some(t) = open.iter().find(|t| t.uid == uid) {
            if seen.insert(uid) {
                out.push(describe(t, lists, now));
            }
        }
    }
    state.fired.retain(|_, at| *at > now - Duration::hours(2 * MISSED_WINDOW_HOURS));
    out
}

fn describe(t: &Task, lists: &[TaskList], now: DateTime<Utc>) -> DueReminder {
    let mut body = due_text(t, now);
    if let Some(list) = lists.iter().find(|l| l.id == t.list_id) {
        if !body.is_empty() {
            body.push_str(" · ");
        }
        body.push_str(&list.name);
    }
    DueReminder {
        uid: t.uid.clone(),
        id: t.id.clone(),
        title: if t.summary.trim().is_empty() { "Untitled task".into() } else { t.summary.clone() },
        body,
    }
}

/// "Due today at 14:30", "Due tomorrow", "Due on Friday", "Due on 12 Oct".
pub fn due_text(t: &Task, now: DateTime<Utc>) -> String {
    let Some(due) = t.due.as_deref().and_then(IcalTime::parse_ui) else { return String::new() };
    let today = now.with_timezone(&Local).date_naive();
    let date = due.local_date();
    let day = match (date - today).num_days() {
        0 => "today".to_string(),
        1 => "tomorrow".to_string(),
        -1 => "yesterday".to_string(),
        2..=6 => format!("on {}", date.format("%A")),
        _ => format!("on {}", date.format("%-d %b")),
    };
    // A reminder at the due time arrives a few seconds late; that isn't "was due".
    let overdue = if due.is_date() { date < today } else { due.instant() < now - Duration::minutes(5) };
    let prefix = if overdue { "Was due" } else { "Due" };
    if due.is_date() {
        format!("{prefix} {day}")
    } else {
        let time = due.instant().with_timezone(&Local).format("%H:%M");
        format!("{prefix} {day} at {time}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reminders::{Related, Reminder};

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn task(uid: &str, due: Option<&str>, reminders: Vec<Reminder>) -> Task {
        Task {
            id: format!("/l/{uid}.ics"),
            uid: uid.into(),
            list_id: "/l/".into(),
            summary: format!("Task {uid}"),
            due: due.map(Into::into),
            reminders,
            modified: Some("2026-10-01T00:00:00Z".into()),
            ..Task::default()
        }
    }

    #[test]
    fn fires_once_and_only_when_due() {
        let tasks = [
            task("a", Some("2026-10-04T10:00:00Z"), vec![Reminder::Relative { offset: -900, related: Related::Due }]),
            task("b", Some("2026-10-04T12:00:00Z"), vec![]), // automatic reminder at the due time
            task("c", Some("2026-10-04"), vec![]),           // all day: no automatic reminder
        ];
        let lists = vec![TaskList { id: "/l/".into(), name: "Work".into(), color: None, order: None, read_only: false, ctag: None }];
        let mut s = AlarmState { since: Some(at("2026-10-01T00:00:00Z")), ..Default::default() };

        let due = collect(tasks.iter(), &lists, &mut s, Some(0), at("2026-10-04T09:44:00Z"));
        assert!(due.is_empty());
        let due = collect(tasks.iter(), &lists, &mut s, Some(0), at("2026-10-04T09:45:05Z"));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].uid, "a");
        assert!(due[0].body.ends_with(" · Work"), "{}", due[0].body);
        // Not again.
        assert!(collect(tasks.iter(), &lists, &mut s, Some(0), at("2026-10-04T09:50:00Z")).is_empty());
        let due = collect(tasks.iter(), &lists, &mut s, Some(0), at("2026-10-04T12:00:01Z"));
        assert_eq!(due.iter().map(|d| d.uid.as_str()).collect::<Vec<_>>(), vec!["b"]);
        // Automatic reminders can be turned off.
        let mut fresh = AlarmState { since: Some(at("2026-10-01T00:00:00Z")), ..Default::default() };
        let due = collect(tasks.iter(), &lists, &mut fresh, None, at("2026-10-04T12:00:01Z"));
        assert_eq!(due.iter().map(|d| d.uid.as_str()).collect::<Vec<_>>(), vec!["a"]);
    }

    #[test]
    fn old_and_stale_reminders_are_skipped() {
        let tasks = [
            task("old", Some("2026-10-02T10:00:00Z"), vec![]),
            task("before-start", Some("2026-10-04T08:00:00Z"), vec![]),
        ];
        let mut s = AlarmState { since: Some(at("2026-10-04T09:00:00Z")), ..Default::default() };
        assert!(collect(tasks.iter(), &[], &mut s, Some(0), at("2026-10-04T10:00:00Z")).is_empty());

        // Created after its reminder time had passed.
        let mut t = task("late", Some("2026-10-04T10:00:00Z"), vec![]);
        t.modified = Some("2026-10-04T10:05:00Z".into());
        let mut s = AlarmState { since: Some(at("2026-10-01T00:00:00Z")), ..Default::default() };
        assert!(collect(std::iter::once(&t), &[], &mut s, Some(0), at("2026-10-04T10:06:00Z")).is_empty());

        // Completed tasks never remind.
        let mut done = task("done", Some("2026-10-04T10:00:00Z"), vec![]);
        done.completed = true;
        assert!(collect(std::iter::once(&done), &[], &mut s, Some(0), at("2026-10-04T10:00:30Z")).is_empty());
    }

    #[test]
    fn snoozed_reminders_come_back() {
        let t = task("a", Some("2026-10-04T10:00:00Z"), vec![]);
        let mut s = AlarmState { since: Some(at("2026-10-01T00:00:00Z")), ..Default::default() };
        assert_eq!(collect(std::iter::once(&t), &[], &mut s, Some(0), at("2026-10-04T10:00:10Z")).len(), 1);
        s.snoozed.insert("a".into(), at("2026-10-04T10:10:10Z"));
        assert!(collect(std::iter::once(&t), &[], &mut s, Some(0), at("2026-10-04T10:05:00Z")).is_empty());
        assert_eq!(collect(std::iter::once(&t), &[], &mut s, Some(0), at("2026-10-04T10:10:20Z")).len(), 1);
        assert!(s.snoozed.is_empty());
    }

    #[test]
    fn first_run_starts_from_now() {
        let t = task("a", Some("2026-10-04T10:00:00Z"), vec![]);
        let mut s = AlarmState::default();
        assert!(collect(std::iter::once(&t), &[], &mut s, Some(0), at("2026-10-04T10:00:10Z")).is_empty());
        assert_eq!(s.since, Some(at("2026-10-04T10:00:10Z")));
    }
}
