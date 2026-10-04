//! Conversion between iCalendar DATE / DATE-TIME values and the simple
//! string representation used by the UI:
//!
//! * `YYYY-MM-DD` – an all-day date
//! * `YYYY-MM-DDTHH:MM:SSZ` – an absolute (UTC) instant
//! * `YYYY-MM-DDTHH:MM:SS` – a floating local time

use chrono::{DateTime, Duration, Months, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};

use crate::ical::Property;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IcalTime {
    Date(NaiveDate),
    Floating(NaiveDateTime),
    Utc(DateTime<Utc>),
}

impl IcalTime {
    /// Reads a DATE or DATE-TIME property. Values with a `TZID` are converted
    /// to UTC when the zone is known, otherwise treated as floating.
    pub fn from_property(prop: &Property) -> Option<IcalTime> {
        let value = prop.value.trim();
        let is_date = prop.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"))
            || (value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit()));
        if is_date {
            return NaiveDate::parse_from_str(&value[..value.len().min(8)], "%Y%m%d").ok().map(IcalTime::Date);
        }
        let (naive_part, utc) = match value.strip_suffix(['Z', 'z']) {
            Some(v) => (v, true),
            None => (value, false),
        };
        let naive = NaiveDateTime::parse_from_str(naive_part, "%Y%m%dT%H%M%S").ok()?;
        if utc {
            return Some(IcalTime::Utc(Utc.from_utc_datetime(&naive)));
        }
        if let Some(tzid) = prop.param("TZID") {
            if let Some(tz) = parse_tzid(tzid) {
                if let Some(dt) = tz.from_local_datetime(&naive).earliest() {
                    return Some(IcalTime::Utc(dt.with_timezone(&Utc)));
                }
            }
        }
        Some(IcalTime::Floating(naive))
    }

    /// Parses the UI representation.
    pub fn parse_ui(s: &str) -> Option<IcalTime> {
        let s = s.trim();
        if s.len() == 10 {
            return NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(IcalTime::Date);
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(IcalTime::Utc(dt.with_timezone(&Utc)));
        }
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
            .ok()
            .map(IcalTime::Floating)
    }

    pub fn to_ui(self) -> String {
        match self {
            IcalTime::Date(d) => d.format("%Y-%m-%d").to_string(),
            IcalTime::Floating(dt) => dt.format("%Y-%m-%dT%H:%M:%S").to_string(),
            IcalTime::Utc(dt) => dt.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        }
    }

    pub fn to_property(self, name: &str) -> Property {
        match self {
            IcalTime::Date(d) => Property::new(name, d.format("%Y%m%d").to_string()).with_param("VALUE", "DATE"),
            IcalTime::Floating(dt) => Property::new(name, dt.format("%Y%m%dT%H%M%S").to_string()),
            IcalTime::Utc(dt) => Property::new(name, dt.format("%Y%m%dT%H%M%SZ").to_string()),
        }
    }

    pub fn is_date(self) -> bool {
        matches!(self, IcalTime::Date(_))
    }

    /// The calendar day this value falls on in the local time zone.
    pub fn local_date(self) -> NaiveDate {
        match self {
            IcalTime::Date(d) => d,
            IcalTime::Floating(dt) => dt.date(),
            IcalTime::Utc(dt) => dt.with_timezone(&chrono::Local).date_naive(),
        }
    }

    /// A comparable instant (all-day values count as local midnight).
    pub fn instant(self) -> DateTime<Utc> {
        let local = match self {
            IcalTime::Utc(dt) => return dt,
            IcalTime::Date(d) => d.and_time(NaiveTime::MIN),
            IcalTime::Floating(dt) => dt,
        };
        chrono::Local
            .from_local_datetime(&local)
            .earliest()
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&local))
    }

    pub fn add_days(self, days: i64) -> IcalTime {
        let d = Duration::days(days);
        match self {
            IcalTime::Date(x) => IcalTime::Date(x + d),
            IcalTime::Floating(x) => IcalTime::Floating(x + d),
            IcalTime::Utc(x) => IcalTime::Utc(shift_utc_local(x, |l| l + d)),
        }
    }

    pub fn add_months(self, months: u32) -> Option<IcalTime> {
        let m = Months::new(months);
        Some(match self {
            IcalTime::Date(x) => IcalTime::Date(x.checked_add_months(m)?),
            IcalTime::Floating(x) => IcalTime::Floating(x.checked_add_months(m)?),
            IcalTime::Utc(x) => {
                let local = x.with_timezone(&chrono::Local).naive_local().checked_add_months(m)?;
                IcalTime::Utc(local_to_utc(local))
            }
        })
    }
}

/// Applies a calendar shift in local time so that "every day at 9:00" stays
/// at 9:00 across DST changes.
fn shift_utc_local(dt: DateTime<Utc>, f: impl Fn(NaiveDateTime) -> NaiveDateTime) -> DateTime<Utc> {
    let local = dt.with_timezone(&chrono::Local).naive_local();
    local_to_utc(f(local))
}

fn local_to_utc(local: NaiveDateTime) -> DateTime<Utc> {
    chrono::Local
        .from_local_datetime(&local)
        .earliest()
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|| Utc.from_utc_datetime(&local))
}

fn parse_tzid(tzid: &str) -> Option<chrono_tz::Tz> {
    let tzid = tzid.trim().trim_matches('"');
    if let Ok(tz) = tzid.parse::<chrono_tz::Tz>() {
        return Some(tz);
    }
    // Mozilla style prefixes: "/mozilla.org/20050126_1/Europe/Berlin"
    let parts: Vec<&str> = tzid.trim_start_matches('/').split('/').collect();
    for take in [3usize, 2, 1] {
        if parts.len() >= take {
            let candidate = parts[parts.len() - take..].join("/");
            if let Ok(tz) = candidate.parse::<chrono_tz::Tz>() {
                return Some(tz);
            }
        }
    }
    None
}

pub fn utc_stamp(dt: DateTime<Utc>) -> String {
    dt.format("%Y%m%dT%H%M%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop(line: &str) -> Property {
        crate::ical::parse(&format!("BEGIN:X\r\n{line}\r\nEND:X\r\n")).unwrap().props.remove(0)
    }

    #[test]
    fn reads_all_forms() {
        assert_eq!(IcalTime::from_property(&prop("DUE;VALUE=DATE:20261004")).unwrap().to_ui(), "2026-10-04");
        assert_eq!(IcalTime::from_property(&prop("DUE:20261004")).unwrap().to_ui(), "2026-10-04");
        assert_eq!(
            IcalTime::from_property(&prop("DUE:20261004T101500Z")).unwrap().to_ui(),
            "2026-10-04T10:15:00Z"
        );
        assert_eq!(
            IcalTime::from_property(&prop("DUE;TZID=Europe/Berlin:20261004T101500")).unwrap().to_ui(),
            "2026-10-04T08:15:00Z"
        );
        assert_eq!(
            IcalTime::from_property(&prop("DUE;TZID=/mozilla.org/20050126_1/America/New_York:20260104T101500"))
                .unwrap()
                .to_ui(),
            "2026-01-04T15:15:00Z"
        );
        assert_eq!(
            IcalTime::from_property(&prop("DUE;TZID=Unknown Zone:20261004T101500")).unwrap().to_ui(),
            "2026-10-04T10:15:00"
        );
    }

    #[test]
    fn ui_round_trip() {
        for s in ["2026-10-04", "2026-10-04T10:15:00Z", "2026-10-04T10:15:00"] {
            let t = IcalTime::parse_ui(s).unwrap();
            assert_eq!(t.to_ui(), s);
            let p = t.to_property("DUE");
            assert_eq!(IcalTime::from_property(&p).unwrap(), t);
        }
        assert_eq!(IcalTime::parse_ui("2026-10-04T10:15:00.000Z").unwrap().to_ui(), "2026-10-04T10:15:00Z");
        assert!(IcalTime::parse_ui("tomorrow").is_none());
    }

    #[test]
    fn month_math_clamps() {
        let t = IcalTime::Date(NaiveDate::from_ymd_opt(2026, 1, 31).unwrap());
        assert_eq!(t.add_months(1).unwrap().to_ui(), "2026-02-28");
    }
}
