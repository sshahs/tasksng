//! Task reminders, stored as standard `VALARM` components so they are shared
//! with Thunderbird, Apple Reminders, Tasks.org and other CalDAV clients.
//!
//! Only `DISPLAY` and `AUDIO` alarms are exposed; anything else (e-mail
//! alarms, snooze helpers written by other apps) is left untouched.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::dates::IcalTime;
use crate::ical::{Component, Property};
use crate::model::{new_uid, Task};

/// The longest offset accepted from the UI (a year either way).
const MAX_OFFSET: i64 = 366 * 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Related {
    /// Relative to DUE (`RELATED=END`).
    #[default]
    Due,
    /// Relative to DTSTART (the iCalendar default).
    Start,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Reminder {
    /// A fixed point in time, as a UTC value in UI format.
    Absolute { at: String },
    /// Seconds before (negative) or after the due or start date.
    Relative {
        offset: i64,
        #[serde(default)]
        related: Related,
    },
}

impl Reminder {
    /// Validates input from the UI and brings it into canonical form.
    pub fn normalized(&self) -> Option<Reminder> {
        match self {
            Reminder::Absolute { at } => {
                let t = IcalTime::parse_ui(at)?;
                Some(Reminder::Absolute { at: IcalTime::Utc(t.instant()).to_ui() })
            }
            Reminder::Relative { offset, related } => {
                (offset.abs() <= MAX_OFFSET).then_some(Reminder::Relative { offset: *offset, related: *related })
            }
        }
    }

    /// When this reminder goes off for `task`, if it can be computed.
    pub fn fire_time(&self, task: &Task) -> Option<DateTime<Utc>> {
        let parse = |v: &Option<String>| v.as_deref().and_then(IcalTime::parse_ui);
        match self {
            Reminder::Absolute { at } => IcalTime::parse_ui(at).map(IcalTime::instant),
            Reminder::Relative { offset, related } => {
                let (due, start) = (parse(&task.due), parse(&task.start));
                // Fall back to the other date, as most clients do.
                let anchor = match related {
                    Related::Due => due.or(start),
                    Related::Start => start.or(due),
                }?;
                Some(anchor.instant() + chrono::Duration::seconds(*offset))
            }
        }
    }
}

fn is_alarm(c: &Component) -> bool {
    c.name.eq_ignore_ascii_case("VALARM")
}

/// Reads a VALARM. Returns `None` for alarms the UI doesn't manage.
pub fn from_alarm(alarm: &Component) -> Option<Reminder> {
    let action = alarm.get("ACTION")?.value.trim().to_ascii_uppercase();
    if action != "DISPLAY" && action != "AUDIO" {
        return None;
    }
    // RFC 9074 snooze alarms belong to another alarm; they are transient.
    let snooze = alarm
        .get_all("RELATED-TO")
        .any(|p| p.param("RELTYPE").is_some_and(|r| r.eq_ignore_ascii_case("SNOOZE")));
    if snooze {
        return None;
    }
    let trigger = alarm.get("TRIGGER")?;
    let value = trigger.value.trim();
    let date_time = trigger.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE-TIME"))
        || !value.trim_start_matches(['+', '-']).starts_with(['P', 'p']);
    if date_time {
        let t = IcalTime::from_property(trigger)?;
        return Some(Reminder::Absolute { at: IcalTime::Utc(t.instant()).to_ui() });
    }
    let offset = parse_duration(value)?;
    let related = match trigger.param("RELATED") {
        Some(r) if r.eq_ignore_ascii_case("END") => Related::Due,
        _ => Related::Start,
    };
    Some(Reminder::Relative { offset, related })
}

pub fn read(todo: &Component) -> Vec<Reminder> {
    todo.children.iter().filter(|c| is_alarm(c)).filter_map(from_alarm).collect()
}

fn same(a: &Reminder, b: &Reminder) -> bool {
    match (a, b) {
        (Reminder::Absolute { at: x }, Reminder::Absolute { at: y }) => {
            IcalTime::parse_ui(x).map(IcalTime::instant) == IcalTime::parse_ui(y).map(IcalTime::instant)
        }
        _ => a == b,
    }
}

fn to_alarm(r: &Reminder, description: &str) -> Component {
    let mut alarm = Component::new("VALARM");
    alarm.push(Property::new("UID", new_uid()));
    alarm.push(Property::new("ACTION", "DISPLAY"));
    alarm.set_text("DESCRIPTION", if description.trim().is_empty() { "Reminder" } else { description.trim() });
    let trigger = match r {
        Reminder::Absolute { at } => {
            let t = IcalTime::parse_ui(at).map(IcalTime::instant).unwrap_or_else(Utc::now);
            IcalTime::Utc(t).to_property("TRIGGER").with_param("VALUE", "DATE-TIME")
        }
        Reminder::Relative { offset, related: Related::Due } => {
            Property::new("TRIGGER", format_duration(*offset)).with_param("RELATED", "END")
        }
        Reminder::Relative { offset, related: Related::Start } => Property::new("TRIGGER", format_duration(*offset)),
    };
    alarm.push(trigger);
    alarm
}

/// Makes the task's alarms match `wanted`: alarms that are still wanted are
/// kept byte for byte (with whatever other apps stored in them), the rest
/// are removed and new ones appended.
pub fn apply(todo: &mut Component, wanted: &[Reminder]) {
    let wanted: Vec<Reminder> = wanted.iter().filter_map(Reminder::normalized).collect();
    let mut open: Vec<Option<&Reminder>> = wanted.iter().map(Some).collect();
    todo.children.retain(|c| {
        if !is_alarm(c) {
            return true;
        }
        let Some(existing) = from_alarm(c) else { return true };
        match open.iter_mut().find(|slot| slot.is_some_and(|w| same(w, &existing))) {
            Some(slot) => {
                *slot = None;
                true
            }
            None => false,
        }
    });
    let summary = todo.text("SUMMARY").unwrap_or_default();
    for r in open.into_iter().flatten() {
        todo.children.push(to_alarm(r, &summary));
    }
}

/// Moves reminders that are set for a fixed time by `days` (in local time),
/// used when a repeating task advances to its next occurrence.
pub fn shift_absolute(todo: &mut Component, days: i64) {
    if days == 0 {
        return;
    }
    for alarm in todo.children.iter_mut().filter(|c| is_alarm(c)) {
        if !matches!(from_alarm(alarm), Some(Reminder::Absolute { .. })) {
            continue;
        }
        let Some(trigger) = alarm.get("TRIGGER") else { continue };
        let Some(t) = IcalTime::from_property(trigger) else { continue };
        let moved = IcalTime::Utc(t.instant()).add_days(days);
        let mut prop = moved.to_property("TRIGGER").with_param("VALUE", "DATE-TIME");
        for p in &trigger.params {
            if !p.name.eq_ignore_ascii_case("VALUE") && !p.name.eq_ignore_ascii_case("TZID") {
                prop.params.push(p.clone());
            }
        }
        alarm.set(prop);
    }
}

/// Parses an iCalendar DURATION (`-PT15M`, `P1D`, `-P1DT2H`, `P2W`) into seconds.
pub fn parse_duration(s: &str) -> Option<i64> {
    let s = s.trim().to_ascii_uppercase();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, s.strip_prefix('+').unwrap_or(&s)),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total: i64 = 0;
    let mut num = String::new();
    let mut in_time = false;
    let mut any = false;
    for c in rest.chars() {
        match c {
            '0'..='9' => num.push(c),
            'T' if num.is_empty() && !in_time => in_time = true,
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                let unit = match (c, in_time) {
                    ('W', false) => 604_800,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
                total = total.checked_add(n.checked_mul(unit)?)?;
                any = true;
            }
            _ => return None,
        }
    }
    (any && num.is_empty()).then_some(sign * total)
}

pub fn format_duration(secs: i64) -> String {
    let sign = if secs < 0 { "-" } else { "" };
    let mut rest = secs.unsigned_abs();
    if rest == 0 {
        return "PT0S".into();
    }
    if rest.is_multiple_of(604_800) {
        return format!("{sign}P{}W", rest / 604_800);
    }
    let mut out = format!("{sign}P");
    let days = rest / 86_400;
    rest %= 86_400;
    if days > 0 {
        out.push_str(&format!("{days}D"));
    }
    if rest > 0 {
        out.push('T');
        let (h, m, s) = (rest / 3_600, rest % 3_600 / 60, rest % 60);
        if h > 0 {
            out.push_str(&format!("{h}H"));
        }
        if m > 0 {
            out.push_str(&format!("{m}M"));
        }
        if s > 0 {
            out.push_str(&format!("{s}S"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ical;

    fn todo(body: &str) -> Component {
        let cal = ical::parse(&format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:u\r\nSUMMARY:Call\r\n{body}END:VTODO\r\nEND:VCALENDAR\r\n"
        ))
        .unwrap();
        cal.children[0].clone()
    }

    #[test]
    fn durations() {
        for (s, n) in [
            ("-PT15M", -900),
            ("PT0S", 0),
            ("P1D", 86_400),
            ("-P1DT2H", -93_600),
            ("P2W", 1_209_600),
            ("+PT1H30M", 5_400),
            ("PT9H", 32_400),
        ] {
            assert_eq!(parse_duration(s), Some(n), "{s}");
        }
        for bad in ["", "P", "PT", "15M", "PT5X", "P1H", "PT1D"] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
        for n in [0, -900, 86_400, -93_600, 1_209_600, 5_400, -54_000, 61] {
            assert_eq!(parse_duration(&format_duration(n)), Some(n));
        }
        assert_eq!(format_duration(-900), "-PT15M");
        assert_eq!(format_duration(-604_800), "-P1W");
        assert_eq!(format_duration(-93_600), "-P1DT2H");
    }

    #[test]
    fn reads_common_client_formats() {
        let t = todo(concat!(
            // Thunderbird / Tasks.org: relative to due
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RELATED=END:-PT15M\r\nEND:VALARM\r\n",
            // Apple Reminders: absolute
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;VALUE=DATE-TIME:20261004T090000Z\r\nEND:VALARM\r\n",
            // relative to start (default RELATED)
            "BEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:PT0S\r\nEND:VALARM\r\n",
            // not shown: e-mail alarm and an RFC 9074 snooze
            "BEGIN:VALARM\r\nACTION:EMAIL\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\n",
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nRELATED-TO;RELTYPE=SNOOZE:x\r\nTRIGGER;VALUE=DATE-TIME:20261004T091000Z\r\nEND:VALARM\r\n",
        ));
        assert_eq!(
            read(&t),
            vec![
                Reminder::Relative { offset: -900, related: Related::Due },
                Reminder::Absolute { at: "2026-10-04T09:00:00Z".into() },
                Reminder::Relative { offset: 0, related: Related::Start },
            ]
        );
    }

    #[test]
    fn apply_keeps_unchanged_alarms_verbatim() {
        let mut t = todo(concat!(
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nX-OTHER-APP:keep\r\nTRIGGER;RELATED=END:-PT15M\r\nEND:VALARM\r\n",
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RELATED=END:-P1D\r\nEND:VALARM\r\n",
            "BEGIN:VALARM\r\nACTION:EMAIL\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\n",
        ));
        apply(
            &mut t,
            &[
                Reminder::Relative { offset: -900, related: Related::Due },
                Reminder::Absolute { at: "2026-10-04T11:00:00+02:00".into() },
            ],
        );
        let ics = t.to_ics();
        assert!(ics.contains("X-OTHER-APP:keep"));
        assert!(!ics.contains("-P1D"));
        assert!(ics.contains("ACTION:EMAIL"));
        assert!(ics.contains("TRIGGER;VALUE=DATE-TIME:20261004T090000Z"));
        assert!(ics.contains("DESCRIPTION:Call"));
        assert_eq!(read(&t).len(), 2);

        apply(&mut t, &[]);
        assert!(read(&t).is_empty());
        assert!(t.to_ics().contains("ACTION:EMAIL"));
    }

    #[test]
    fn fire_times() {
        let task = Task {
            due: Some("2026-10-05T14:00:00Z".into()),
            start: Some("2026-10-04T09:00:00Z".into()),
            ..Task::default()
        };
        let at = |r: Reminder| r.fire_time(&task).unwrap().to_rfc3339();
        assert_eq!(at(Reminder::Relative { offset: -900, related: Related::Due }), "2026-10-05T13:45:00+00:00");
        assert_eq!(at(Reminder::Relative { offset: 0, related: Related::Start }), "2026-10-04T09:00:00+00:00");
        assert_eq!(at(Reminder::Absolute { at: "2026-10-01T08:00:00Z".into() }), "2026-10-01T08:00:00+00:00");
        let no_dates = Task::default();
        assert!(Reminder::Relative { offset: 0, related: Related::Due }.fire_time(&no_dates).is_none());
    }

    #[test]
    fn json_shape() {
        let r: Vec<Reminder> =
            serde_json::from_str(r#"[{"offset":-900,"related":"due"},{"at":"2026-10-04T09:00:00Z"},{"offset":60}]"#).unwrap();
        assert_eq!(r[2], Reminder::Relative { offset: 60, related: Related::Due });
        assert_eq!(serde_json::to_string(&r[0]).unwrap(), r#"{"offset":-900,"related":"due"}"#);
    }
}
