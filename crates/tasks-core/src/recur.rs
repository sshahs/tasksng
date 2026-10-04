//! Minimal RRULE support for repeating tasks.
//!
//! Like Apple Reminders and Tasks.org, completing a repeating task moves it to
//! its next occurrence instead of closing it. Only the common rules a task app
//! creates are understood (`FREQ`, `INTERVAL`, `UNTIL`, and plain `BYDAY` for
//! weekly rules); anything more exotic is reported as unsupported and the task
//! is simply completed so we never invent occurrences that don't exist.

use chrono::{Datelike, NaiveDate, Weekday};

use crate::dates::IcalTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: u32,
    pub until: Option<IcalTime>,
    pub byday: Vec<Weekday>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Advance {
    Next(IcalTime),
    /// The series has ended (UNTIL passed).
    Finished,
    Unsupported,
}

pub fn parse_rrule(s: &str) -> Option<Rule> {
    let mut freq = None;
    let mut interval = 1;
    let mut until = None;
    let mut byday = Vec::new();
    for part in s.trim().trim_start_matches("RRULE:").split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.trim().to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                })
            }
            "INTERVAL" => interval = v.trim().parse().ok().filter(|i| *i > 0)?,
            "UNTIL" => {
                let prop = crate::ical::Property::new("UNTIL", v.trim());
                until = Some(IcalTime::from_property(&prop)?);
            }
            "BYDAY" => {
                for d in v.split(',') {
                    byday.push(match d.trim().to_ascii_uppercase().as_str() {
                        "MO" => Weekday::Mon,
                        "TU" => Weekday::Tue,
                        "WE" => Weekday::Wed,
                        "TH" => Weekday::Thu,
                        "FR" => Weekday::Fri,
                        "SA" => Weekday::Sat,
                        "SU" => Weekday::Sun,
                        _ => return None, // ordinals like 2MO are not supported
                    });
                }
            }
            "WKST" => {}
            _ => return None, // COUNT, BYMONTHDAY, BYSETPOS, …
        }
    }
    let freq = freq?;
    if !byday.is_empty() && freq != Freq::Weekly {
        return None;
    }
    Some(Rule { freq, interval, until, byday })
}

/// Computes the next occurrence after `current`, skipping occurrences that
/// fall before `not_before` (so an overdue daily task lands on today).
pub fn advance(rrule: &str, current: IcalTime, not_before: NaiveDate) -> Advance {
    let Some(rule) = parse_rrule(rrule) else { return Advance::Unsupported };
    let mut next = current;
    for _ in 0..5000 {
        next = match step(&rule, next) {
            Some(n) => n,
            None => return Advance::Unsupported,
        };
        if let Some(until) = rule.until {
            if next.instant() > until.instant() && next.local_date() > until.local_date() {
                return Advance::Finished;
            }
        }
        if next.local_date() >= not_before {
            return Advance::Next(next);
        }
    }
    Advance::Unsupported
}

fn step(rule: &Rule, t: IcalTime) -> Option<IcalTime> {
    let n = rule.interval;
    match rule.freq {
        Freq::Daily => Some(t.add_days(n as i64)),
        Freq::Weekly if rule.byday.is_empty() => Some(t.add_days(7 * n as i64)),
        Freq::Weekly => {
            let start = t.local_date();
            let week0 = monday_of(start);
            for offset in 1..=(7 * n as i64 + 7) {
                let d = start + chrono::Duration::days(offset);
                let weeks = (monday_of(d) - week0).num_days() / 7;
                if weeks % n as i64 == 0 && rule.byday.contains(&d.weekday()) {
                    return Some(t.add_days(offset));
                }
            }
            None
        }
        Freq::Monthly => t.add_months(n),
        Freq::Yearly => t.add_months(12 * n),
    }
}

fn monday_of(d: NaiveDate) -> NaiveDate {
    d - chrono::Duration::days(d.weekday().num_days_from_monday() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> IcalTime {
        IcalTime::parse_ui(s).unwrap()
    }
    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn simple_frequencies() {
        let from = d("2000-01-01");
        assert_eq!(advance("FREQ=DAILY", date("2026-10-04"), from), Advance::Next(date("2026-10-05")));
        assert_eq!(advance("FREQ=DAILY;INTERVAL=3", date("2026-10-04"), from), Advance::Next(date("2026-10-07")));
        assert_eq!(advance("FREQ=WEEKLY", date("2026-10-04"), from), Advance::Next(date("2026-10-11")));
        assert_eq!(advance("FREQ=MONTHLY", date("2026-01-31"), from), Advance::Next(date("2026-02-28")));
        assert_eq!(advance("FREQ=YEARLY", date("2028-02-29"), from), Advance::Next(date("2029-02-28")));
    }

    #[test]
    fn weekdays() {
        let rule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
        let from = d("2000-01-01");
        // Friday -> Monday
        assert_eq!(advance(rule, date("2026-10-02"), from), Advance::Next(date("2026-10-05")));
        // Monday -> Tuesday
        assert_eq!(advance(rule, date("2026-10-05"), from), Advance::Next(date("2026-10-06")));
        // Every second week on Monday
        assert_eq!(
            advance("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", date("2026-10-05"), from),
            Advance::Next(date("2026-10-19"))
        );
    }

    #[test]
    fn skips_missed_occurrences() {
        assert_eq!(advance("FREQ=DAILY", date("2026-09-01"), d("2026-10-04")), Advance::Next(date("2026-10-04")));
    }

    #[test]
    fn until_and_unsupported() {
        let from = d("2000-01-01");
        assert_eq!(advance("FREQ=DAILY;UNTIL=20261004", date("2026-10-04"), from), Advance::Finished);
        assert_eq!(advance("FREQ=DAILY;COUNT=3", date("2026-10-04"), from), Advance::Unsupported);
        assert_eq!(advance("FREQ=MONTHLY;BYDAY=2MO", date("2026-10-04"), from), Advance::Unsupported);
        assert_eq!(advance("FREQ=HOURLY", date("2026-10-04"), from), Advance::Unsupported);
    }
}
