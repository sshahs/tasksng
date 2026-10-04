//! The task model exposed to the UI and the functions that translate it to
//! and from `VTODO` components.

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::dates::{utc_stamp, IcalTime};
use crate::ical::{self, Component, Property};
use crate::recur::{self, Advance};

pub const PRODID: &str = "-//TasksNG//TasksNG for Windows//EN";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    NeedsAction,
    InProcess,
    Completed,
    Cancelled,
}

impl TaskStatus {
    fn from_ical(s: &str) -> Self {
        match s.trim().to_ascii_uppercase().as_str() {
            "COMPLETED" => TaskStatus::Completed,
            "IN-PROCESS" => TaskStatus::InProcess,
            "CANCELLED" => TaskStatus::Cancelled,
            _ => TaskStatus::NeedsAction,
        }
    }

    fn as_ical(self) -> &'static str {
        match self {
            TaskStatus::NeedsAction => "NEEDS-ACTION",
            TaskStatus::InProcess => "IN-PROCESS",
            TaskStatus::Completed => "COMPLETED",
            TaskStatus::Cancelled => "CANCELLED",
        }
    }

    pub fn is_done(self) -> bool {
        matches!(self, TaskStatus::Completed | TaskStatus::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// The resource path on the server; unique per task.
    pub id: String,
    pub uid: String,
    pub list_id: String,
    pub summary: String,
    pub description: String,
    pub status: TaskStatus,
    pub completed: bool,
    pub completed_at: Option<String>,
    /// 0 = undefined, 1 = highest … 9 = lowest (RFC 5545).
    pub priority: u8,
    pub due: Option<String>,
    pub start: Option<String>,
    pub categories: Vec<String>,
    pub parent_uid: Option<String>,
    pub rrule: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub sort_order: Option<i64>,
    /// Local changes that have not reached the server yet.
    pub pending: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewTask {
    pub summary: String,
    pub description: Option<String>,
    pub priority: Option<u8>,
    pub due: Option<String>,
    pub categories: Vec<String>,
    pub parent_uid: Option<String>,
    pub rrule: Option<String>,
}

/// A partial update. For nullable fields `Some(None)` clears the value and
/// `None` leaves it untouched.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskPatch {
    pub summary: Option<String>,
    #[serde(deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    pub status: Option<TaskStatus>,
    pub priority: Option<u8>,
    #[serde(deserialize_with = "double_option")]
    pub due: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub start: Option<Option<String>>,
    pub categories: Option<Vec<String>>,
    #[serde(deserialize_with = "double_option")]
    pub parent_uid: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub rrule: Option<Option<String>>,
    pub sort_order: Option<i64>,
}

fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchOutcome {
    Updated,
    /// A repeating task was completed and moved to its next occurrence.
    Advanced { due: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error(transparent)]
    Parse(#[from] ical::ParseError),
    #[error("the calendar object does not contain a task")]
    NoTask,
    #[error("invalid date '{0}'")]
    BadDate(String),
}

/// Index of the master VTODO (the one without RECURRENCE-ID).
fn master_index(cal: &Component) -> Option<usize> {
    let mut first = None;
    for (i, c) in cal.children.iter().enumerate() {
        if c.name.eq_ignore_ascii_case("VTODO") {
            if c.get("RECURRENCE-ID").is_none() {
                return Some(i);
            }
            first.get_or_insert(i);
        }
    }
    first
}

pub fn master_todo(cal: &Component) -> Option<&Component> {
    master_index(cal).map(|i| &cal.children[i])
}

fn master_todo_mut(cal: &mut Component) -> Option<&mut Component> {
    master_index(cal).map(move |i| &mut cal.children[i])
}

fn time_ui(todo: &Component, name: &str) -> Option<String> {
    todo.get(name).and_then(IcalTime::from_property).map(IcalTime::to_ui)
}

/// Builds the UI model for a stored calendar object.
pub fn task_from_ics(id: &str, list_id: &str, ics: &str, pending: bool) -> Result<Task, ModelError> {
    let cal = ical::parse(ics)?;
    let todo = master_todo(&cal).ok_or(ModelError::NoTask)?;
    let status = todo.get("STATUS").map(|p| TaskStatus::from_ical(&p.value)).unwrap_or_else(|| {
        if todo.get("COMPLETED").is_some() {
            TaskStatus::Completed
        } else {
            TaskStatus::NeedsAction
        }
    });
    let categories = todo
        .get_all("CATEGORIES")
        .flat_map(|p| ical::split_text_list(&p.value))
        .collect::<Vec<_>>();
    let parent_uid = todo
        .get_all("RELATED-TO")
        .find(|p| p.param("RELTYPE").is_none_or(|r| r.eq_ignore_ascii_case("PARENT")))
        .map(|p| p.text().trim().to_string())
        .filter(|s| !s.is_empty());
    let sort_order = todo
        .get("X-APPLE-SORT-ORDER")
        .and_then(|p| p.value.trim().parse::<i64>().ok());
    Ok(Task {
        id: id.to_string(),
        uid: todo.text("UID").unwrap_or_default(),
        list_id: list_id.to_string(),
        summary: todo.text("SUMMARY").unwrap_or_default(),
        description: todo.text("DESCRIPTION").unwrap_or_default(),
        status,
        completed: status.is_done(),
        completed_at: time_ui(todo, "COMPLETED"),
        priority: todo.get("PRIORITY").and_then(|p| p.value.trim().parse::<u8>().ok()).unwrap_or(0).min(9),
        due: time_ui(todo, "DUE"),
        start: time_ui(todo, "DTSTART"),
        categories,
        parent_uid,
        rrule: todo.get("RRULE").map(|p| p.value.trim().to_string()),
        created: time_ui(todo, "CREATED"),
        modified: time_ui(todo, "LAST-MODIFIED"),
        sort_order,
        pending,
    })
}

pub fn new_uid() -> String {
    uuid::Uuid::new_v4().to_string().to_uppercase()
}

/// Creates the iCalendar text for a brand new task.
pub fn build_ics(uid: &str, input: &NewTask, now: DateTime<Utc>) -> Result<String, ModelError> {
    let mut cal = Component::new("VCALENDAR");
    cal.push(Property::new("VERSION", "2.0"));
    cal.push(Property::new("PRODID", PRODID));
    let mut todo = Component::new("VTODO");
    let stamp = utc_stamp(now);
    todo.push(Property::new("UID", uid));
    todo.push(Property::new("DTSTAMP", stamp.clone()));
    todo.push(Property::new("CREATED", stamp.clone()));
    todo.push(Property::new("LAST-MODIFIED", stamp));
    todo.set_text("SUMMARY", input.summary.trim());
    todo.push(Property::new("STATUS", "NEEDS-ACTION"));
    cal.children.push(todo);

    let patch = TaskPatch {
        description: input.description.clone().map(Some),
        priority: input.priority,
        due: input.due.clone().map(Some),
        categories: Some(input.categories.clone()),
        parent_uid: input.parent_uid.clone().map(Some),
        rrule: input.rrule.clone().map(Some),
        ..Default::default()
    };
    let todo = master_todo_mut(&mut cal).expect("just added");
    apply_to_todo(todo, &patch, now)?;
    Ok(cal.to_ics())
}

/// Applies `patch` to the master VTODO of `ics` and returns the new text.
pub fn patch_ics(ics: &str, patch: &TaskPatch, now: DateTime<Utc>) -> Result<(String, PatchOutcome), ModelError> {
    let mut cal = ical::parse(ics)?;
    let todo = master_todo_mut(&mut cal).ok_or(ModelError::NoTask)?;
    let outcome = apply_to_todo(todo, patch, now)?;
    let stamp = utc_stamp(now);
    todo.set(Property::new("LAST-MODIFIED", stamp.clone()));
    todo.set(Property::new("DTSTAMP", stamp));
    Ok((cal.to_ics(), outcome))
}

fn parse_time(s: &str) -> Result<IcalTime, ModelError> {
    IcalTime::parse_ui(s).ok_or_else(|| ModelError::BadDate(s.to_string()))
}

fn apply_to_todo(todo: &mut Component, patch: &TaskPatch, now: DateTime<Utc>) -> Result<PatchOutcome, ModelError> {
    let mut outcome = PatchOutcome::Updated;

    if let Some(summary) = &patch.summary {
        todo.set_text("SUMMARY", summary.trim());
    }
    if let Some(desc) = &patch.description {
        match desc.as_deref().map(str::trim_end).filter(|d| !d.is_empty()) {
            Some(d) => todo.set_text("DESCRIPTION", d),
            None => todo.remove("DESCRIPTION"),
        }
    }
    if let Some(priority) = patch.priority {
        if priority == 0 {
            todo.remove("PRIORITY");
        } else {
            todo.set(Property::new("PRIORITY", priority.min(9).to_string()));
        }
    }
    if let Some(cats) = &patch.categories {
        todo.remove("CATEGORIES");
        let cats: Vec<String> = cats.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
        if !cats.is_empty() {
            todo.push(Property::new("CATEGORIES", ical::join_text_list(&cats)));
        }
    }
    if let Some(parent) = &patch.parent_uid {
        // Only touch the parent link; keep CHILD/SIBLING relations intact.
        todo.props.retain(|p| {
            !(p.name.eq_ignore_ascii_case("RELATED-TO")
                && p.param("RELTYPE").is_none_or(|r| r.eq_ignore_ascii_case("PARENT")))
        });
        if let Some(uid) = parent.as_deref().filter(|u| !u.trim().is_empty()) {
            todo.push(Property::new("RELATED-TO", ical::escape_text(uid.trim())).with_param("RELTYPE", "PARENT"));
        }
    }
    if let Some(order) = patch.sort_order {
        todo.set(Property::new("X-APPLE-SORT-ORDER", order.to_string()));
    }
    if let Some(due) = &patch.due {
        match due {
            Some(d) => {
                let t = parse_time(d)?;
                todo.set(t.to_property("DUE"));
                // DURATION and DUE are mutually exclusive.
                todo.remove("DURATION");
            }
            None => todo.remove("DUE"),
        }
    }
    if let Some(start) = &patch.start {
        match start {
            Some(s) => todo.set(parse_time(s)?.to_property("DTSTART")),
            None => todo.remove("DTSTART"),
        }
    }
    if let Some(rrule) = &patch.rrule {
        match rrule.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            Some(r) => {
                todo.set(Property::new("RRULE", r.trim_start_matches("RRULE:")));
                // A recurrence needs an anchor.
                if todo.get("DUE").is_none() && todo.get("DTSTART").is_none() {
                    todo.set(IcalTime::Date(now.with_timezone(&Local).date_naive()).to_property("DUE"));
                }
            }
            None => todo.remove("RRULE"),
        }
    }
    if let Some(status) = patch.status {
        outcome = set_status(todo, status, now);
    }
    normalize_start(todo);
    Ok(outcome)
}

fn set_status(todo: &mut Component, status: TaskStatus, now: DateTime<Utc>) -> PatchOutcome {
    if status == TaskStatus::Completed {
        if let Some(next) = advance_recurrence(todo, now) {
            return PatchOutcome::Advanced { due: next };
        }
    }
    todo.set(Property::new("STATUS", status.as_ical()));
    match status {
        TaskStatus::Completed => {
            todo.set(Property::new("COMPLETED", utc_stamp(now)));
            todo.set(Property::new("PERCENT-COMPLETE", "100"));
        }
        TaskStatus::NeedsAction => {
            todo.remove("COMPLETED");
            todo.remove("PERCENT-COMPLETE");
        }
        TaskStatus::InProcess | TaskStatus::Cancelled => {
            todo.remove("COMPLETED");
        }
    }
    PatchOutcome::Updated
}

/// Moves a repeating task to its next occurrence. Returns the new due (or
/// start) date, or `None` when the task should simply be completed.
fn advance_recurrence(todo: &mut Component, now: DateTime<Utc>) -> Option<String> {
    let rrule = todo.get("RRULE")?.value.clone();
    let due = todo.get("DUE").and_then(IcalTime::from_property);
    let start = todo.get("DTSTART").and_then(IcalTime::from_property);
    let anchor = due.or(start)?;
    let today = now.with_timezone(&Local).date_naive();
    let next = match recur::advance(&rrule, anchor, today) {
        Advance::Next(n) => n,
        Advance::Finished | Advance::Unsupported => return None,
    };
    let shift = (next.local_date() - anchor.local_date()).num_days();
    if due.is_some() {
        let prop = keep_params(todo.get("DUE"), next.to_property("DUE"));
        todo.set(prop);
    }
    if let Some(s) = start {
        let new_start = if due.is_some() { s.add_days(shift) } else { next };
        let prop = keep_params(todo.get("DTSTART"), new_start.to_property("DTSTART"));
        todo.set(prop);
    }
    todo.set(Property::new("STATUS", "NEEDS-ACTION"));
    todo.remove("COMPLETED");
    todo.remove("PERCENT-COMPLETE");
    let anchor_out = todo.get("DUE").or_else(|| todo.get("DTSTART")).and_then(IcalTime::from_property)?;
    Some(anchor_out.to_ui())
}

/// Keeps unrelated parameters (e.g. X- params) of the previous property but
/// drops TZID/VALUE which are dictated by the new value.
fn keep_params(old: Option<&Property>, mut new: Property) -> Property {
    if let Some(old) = old {
        for p in &old.params {
            let n = p.name.to_ascii_uppercase();
            if n != "TZID" && n != "VALUE" && new.param(&p.name).is_none() {
                new.params.push(p.clone());
            }
        }
    }
    new
}

/// RFC 5545 (and sabre/vobject validation) require DTSTART and DUE to share
/// a value type, and DUE must not precede DTSTART.
fn normalize_start(todo: &mut Component) {
    let (Some(due), Some(start)) = (
        todo.get("DUE").and_then(IcalTime::from_property),
        todo.get("DTSTART").and_then(IcalTime::from_property),
    ) else {
        return;
    };
    let mut new_start = start;
    if due.is_date() != start.is_date() {
        new_start = if due.is_date() {
            IcalTime::Date(start.local_date())
        } else {
            IcalTime::Utc(IcalTime::Date(start.local_date()).instant())
        };
    }
    if new_start.instant() > due.instant() {
        new_start = due;
    }
    if new_start != start {
        todo.set(new_start.to_property("DTSTART"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 4, 12, 0, 0).unwrap()
    }

    fn new_task(summary: &str) -> String {
        build_ics("UID-1", &NewTask { summary: summary.into(), ..Default::default() }, now()).unwrap()
    }

    #[test]
    fn builds_valid_new_task() {
        let ics = build_ics(
            "UID-1",
            &NewTask {
                summary: "Pay rent".into(),
                description: Some("before the 5th".into()),
                priority: Some(1),
                due: Some("2026-10-05".into()),
                categories: vec!["Home".into(), "Money".into()],
                parent_uid: Some("PARENT".into()),
                rrule: None,
            },
            now(),
        )
        .unwrap();
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:"));
        assert!(ics.contains("DTSTAMP:20261004T120000Z"));
        let t = task_from_ics("/cal/x.ics", "/cal/", &ics, true).unwrap();
        assert_eq!(t.uid, "UID-1");
        assert_eq!(t.summary, "Pay rent");
        assert_eq!(t.description, "before the 5th");
        assert_eq!(t.priority, 1);
        assert_eq!(t.due.as_deref(), Some("2026-10-05"));
        assert_eq!(t.categories, vec!["Home", "Money"]);
        assert_eq!(t.parent_uid.as_deref(), Some("PARENT"));
        assert_eq!(t.status, TaskStatus::NeedsAction);
        assert!(!t.completed);
    }

    #[test]
    fn complete_and_reopen() {
        let ics = new_task("x");
        let patch = TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() };
        let (ics, outcome) = patch_ics(&ics, &patch, now()).unwrap();
        assert_eq!(outcome, PatchOutcome::Updated);
        let t = task_from_ics("a", "b", &ics, false).unwrap();
        assert!(t.completed);
        assert_eq!(t.completed_at.as_deref(), Some("2026-10-04T12:00:00Z"));
        assert!(ics.contains("PERCENT-COMPLETE:100"));

        let patch = TaskPatch { status: Some(TaskStatus::NeedsAction), ..Default::default() };
        let (ics, _) = patch_ics(&ics, &patch, now()).unwrap();
        let t = task_from_ics("a", "b", &ics, false).unwrap();
        assert!(!t.completed);
        assert!(t.completed_at.is_none());
        assert!(!ics.contains("PERCENT-COMPLETE"));
    }

    #[test]
    fn patch_preserves_foreign_data() {
        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:other\r\nBEGIN:VTODO\r\nUID:u\r\nDTSTAMP:20200101T000000Z\r\nSUMMARY:old\r\nX-TASKS-ORG-ID:42\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
        let patch = TaskPatch { summary: Some("new".into()), ..Default::default() };
        let (out, _) = patch_ics(ics, &patch, now()).unwrap();
        assert!(out.contains("SUMMARY:new"));
        assert!(out.contains("X-TASKS-ORG-ID:42"));
        assert!(out.contains("TRIGGER:-PT5M"));
        assert!(out.contains("PRODID:other"));
        assert!(out.contains("LAST-MODIFIED:20261004T120000Z"));
    }

    #[test]
    fn clears_nullable_fields() {
        let ics = build_ics(
            "u",
            &NewTask { summary: "x".into(), due: Some("2026-10-05".into()), description: Some("d".into()), ..Default::default() },
            now(),
        )
        .unwrap();
        let patch: TaskPatch = serde_json::from_str(r#"{"due":null,"description":null,"priority":0}"#).unwrap();
        let (out, _) = patch_ics(&ics, &patch, now()).unwrap();
        let t = task_from_ics("a", "b", &out, false).unwrap();
        assert!(t.due.is_none());
        assert_eq!(t.description, "");
        // Untouched when the key is absent.
        let patch: TaskPatch = serde_json::from_str(r#"{"summary":"y"}"#).unwrap();
        assert!(patch.due.is_none());
    }

    #[test]
    fn repeating_task_advances_instead_of_completing() {
        let ics = build_ics(
            "u",
            &NewTask { summary: "water plants".into(), due: Some("2026-10-04".into()), rrule: Some("FREQ=WEEKLY".into()), ..Default::default() },
            now(),
        )
        .unwrap();
        let patch = TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() };
        let (out, outcome) = patch_ics(&ics, &patch, now()).unwrap();
        assert_eq!(outcome, PatchOutcome::Advanced { due: "2026-10-11".into() });
        let t = task_from_ics("a", "b", &out, false).unwrap();
        assert!(!t.completed);
        assert_eq!(t.due.as_deref(), Some("2026-10-11"));
    }

    #[test]
    fn repeat_without_due_gets_anchor() {
        let ics = new_task("x");
        let patch = TaskPatch { rrule: Some(Some("FREQ=DAILY".into())), ..Default::default() };
        let (out, _) = patch_ics(&ics, &patch, now()).unwrap();
        let t = task_from_ics("a", "b", &out, false).unwrap();
        assert!(t.due.is_some());
        assert_eq!(t.rrule.as_deref(), Some("FREQ=DAILY"));
    }

    #[test]
    fn start_is_kept_consistent_with_due() {
        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VTODO\r\nUID:u\r\nDTSTAMP:20200101T000000Z\r\nDTSTART:20261010T090000Z\r\nDUE:20261011T090000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
        // Due becomes an all-day value before the start.
        let patch = TaskPatch { due: Some(Some("2026-10-05".into())), ..Default::default() };
        let (out, _) = patch_ics(ics, &patch, now()).unwrap();
        let t = task_from_ics("a", "b", &out, false).unwrap();
        assert_eq!(t.due.as_deref(), Some("2026-10-05"));
        assert_eq!(t.start.as_deref(), Some("2026-10-05"));
    }

    #[test]
    fn reads_recurrence_overrides_master() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:u\r\nRECURRENCE-ID:20261005T000000Z\r\nSUMMARY:override\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:u\r\nSUMMARY:master\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
        assert_eq!(task_from_ics("a", "b", ics, false).unwrap().summary, "master");
    }

    #[test]
    fn completed_without_status() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:u\r\nCOMPLETED:20261005T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
        assert!(task_from_ics("a", "b", ics, false).unwrap().completed);
    }
}
