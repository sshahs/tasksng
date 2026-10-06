//! Calendar events for the day planner. Read only: TasksNG shows them next
//! to the tasks but leaves editing them to calendar apps.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::dates::{duration_minutes, IcalTime};
use crate::ical::{self, Component};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    /// The resource plus the occurrence: unique per occurrence.
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    /// `YYYY-MM-DD` for all-day events, otherwise a UTC instant.
    pub start: String,
    /// Exclusive, like DTEND.
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    /// The calendar's colour.
    pub color: Option<String>,
}

/// What the day planner gets: the events, when they were downloaded, and
/// why they couldn't be refreshed (then they come from the cache).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsResult {
    pub events: Vec<CalEvent>,
    pub fetched_at: Option<String>,
    pub error: Option<String>,
}

/// Reads a range sent by the UI (`from` before `to`, at most 62 days).
pub fn parse_range(from: &str, to: &str) -> Result<(DateTime<Utc>, DateTime<Utc>), crate::Error> {
    let at = |s: &str| IcalTime::parse_ui(s).map(IcalTime::instant).ok_or_else(|| crate::Error::InvalidInput(format!("invalid date '{s}'")));
    let (f, t) = (at(from)?, at(to)?);
    if t <= f || t - f > Duration::days(62) {
        return Err(crate::Error::InvalidInput("invalid range".into()));
    }
    Ok((f, t))
}

/// The events of one calendar object (several when the server expanded a
/// repeating event) that overlap `from..to`.
pub fn parse(href: &str, calendar_id: &str, color: Option<&str>, ics: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<CalEvent> {
    let Ok(cal) = ical::parse(ics) else {
        log::warn!("skipping unreadable event {href}");
        return Vec::new();
    };
    cal.children
        .iter()
        .filter(|c| c.name.eq_ignore_ascii_case("VEVENT"))
        .filter_map(|ev| event(href, calendar_id, color, ev))
        .filter(|e| overlaps(e, from, to))
        .collect()
}

fn event(href: &str, calendar_id: &str, color: Option<&str>, ev: &Component) -> Option<CalEvent> {
    if ev.text("STATUS").is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED")) {
        return None;
    }
    let start = ev.get("DTSTART").and_then(IcalTime::from_property)?;
    let end = ev
        .get("DTEND")
        .and_then(IcalTime::from_property)
        .or_else(|| {
            let minutes = ev.get("DURATION").and_then(|d| duration_minutes(&d.value))?;
            Some(match start {
                IcalTime::Date(_) => start.add_days(i64::from(minutes) / (24 * 60)),
                _ => IcalTime::Utc(start.instant() + Duration::minutes(i64::from(minutes))),
            })
        })
        // RFC 5545: an all-day event without an end lasts the day, a timed one no time at all.
        .unwrap_or(if start.is_date() { start.add_days(1) } else { start });
    let all_day = start.is_date();
    let ui = |t: IcalTime| if all_day { IcalTime::Date(t.local_date()).to_ui() } else { IcalTime::Utc(t.instant()).to_ui() };
    let occurrence = ev.get("RECURRENCE-ID").map(|p| p.value.trim().to_string()).unwrap_or_default();
    Some(CalEvent {
        id: if occurrence.is_empty() { href.to_string() } else { format!("{href}#{occurrence}") },
        calendar_id: calendar_id.to_string(),
        title: ev.text("SUMMARY").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Busy".into()),
        start: ui(start),
        end: ui(end),
        all_day,
        location: ev.text("LOCATION").filter(|s| !s.trim().is_empty()),
        color: color.map(str::to_string),
    })
}

fn overlaps(e: &CalEvent, from: DateTime<Utc>, to: DateTime<Utc>) -> bool {
    let at = |s: &str| IcalTime::parse_ui(s).map(IcalTime::instant);
    match (at(&e.start), at(&e.end)) {
        // Zero-length events count when they start inside the range.
        (Some(s), Some(end)) if end <= s => s >= from && s < to,
        (Some(s), Some(end)) => s < to && end > from,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn day() -> (DateTime<Utc>, DateTime<Utc>) {
        (Utc.with_ymd_and_hms(2026, 10, 6, 0, 0, 0).unwrap(), Utc.with_ymd_and_hms(2026, 10, 7, 0, 0, 0).unwrap())
    }

    fn cal(events: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\n{events}END:VCALENDAR\r\n")
    }

    #[test]
    fn reads_timed_all_day_and_expanded_events() {
        let (from, to) = day();
        let ics = cal(concat!(
            "BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261006T090000Z\r\nDTEND:20261006T100000Z\r\nSUMMARY:Stand-up\r\nLOCATION:Room 1\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20261006T150000Z\r\nDTSTART:20261006T150000Z\r\nDURATION:PT30M\r\nSUMMARY:Stand-up\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20261006\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z\r\nSUMMARY:Later\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20261006T110000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Off\r\nEND:VEVENT\r\n",
        ));
        let events = parse("/cal/a.ics", "/cal/", Some("#3B82F6"), &ics, from, to);
        let titles: Vec<(&str, &str, &str)> = events.iter().map(|e| (e.title.as_str(), e.start.as_str(), e.end.as_str())).collect();
        assert_eq!(
            titles,
            vec![
                ("Stand-up", "2026-10-06T09:00:00Z", "2026-10-06T10:00:00Z"),
                ("Stand-up", "2026-10-06T15:00:00Z", "2026-10-06T15:30:00Z"),
                ("Holiday", "2026-10-06", "2026-10-07"),
            ]
        );
        assert_eq!(events[0].location.as_deref(), Some("Room 1"));
        assert_eq!(events[1].id, "/cal/a.ics#20261006T150000Z");
        assert!(events[2].all_day);
        assert_eq!(events[0].color.as_deref(), Some("#3B82F6"));
    }

    #[test]
    fn events_crossing_midnight_count_on_both_days() {
        let (from, to) = day();
        let ics = cal("BEGIN:VEVENT\r\nUID:n\r\nDTSTART:20261005T220000Z\r\nDTEND:20261006T020000Z\r\nEND:VEVENT\r\n");
        let events = parse("/cal/n.ics", "/cal/", None, &ics, from, to);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Busy");
    }
}
