//! RRULE support for repeating tasks.
//!
//! Like Apple Reminders and Tasks.org, completing a repeating task moves it to
//! its next occurrence instead of closing it. The rules task apps create are
//! understood: `FREQ`, `INTERVAL`, `UNTIL`, `COUNT` (counted down as
//! occurrences are completed), `BYDAY` (with ordinals such as `-1FR` for
//! monthly and yearly rules), `BYMONTHDAY`, `BYMONTH` and `BYSETPOS`.
//! `FROM=COMPLETION` marks a task that repeats relative to when it was
//! completed (see [`crate::model`] for how that is stored). Anything more
//! exotic is reported as unsupported and the task is simply completed, so we
//! never invent occurrences that don't exist.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

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
    /// Occurrences left, including the current one.
    pub count: Option<u32>,
    /// `(ordinal, weekday)`; ordinal 0 means every such weekday.
    pub byday: Vec<(i32, Weekday)>,
    pub bymonthday: Vec<i32>,
    pub bymonth: Vec<u32>,
    pub bysetpos: Vec<i32>,
    pub from_completion: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Advance {
    /// The next occurrence and the rule to store with it (COUNT goes down).
    Next { at: IcalTime, rrule: String },
    /// The series has ended (UNTIL passed or COUNT used up).
    Finished,
    Unsupported,
}

pub const FROM_COMPLETION: &str = "FROM=COMPLETION";

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

fn int_list(v: &str, valid: impl Fn(i32) -> bool) -> Option<Vec<i32>> {
    v.split(',')
        .map(|x| x.trim().trim_start_matches('+').parse::<i32>().ok().filter(|n| valid(*n)))
        .collect()
}

pub fn parse_rrule(s: &str) -> Option<Rule> {
    let mut rule = Rule {
        freq: Freq::Daily,
        interval: 1,
        until: None,
        count: None,
        byday: Vec::new(),
        bymonthday: Vec::new(),
        bymonth: Vec::new(),
        bysetpos: Vec::new(),
        from_completion: false,
    };
    let mut freq = None;
    for part in s.trim().trim_start_matches("RRULE:").split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        let v = v.trim().to_ascii_uppercase();
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                })
            }
            "INTERVAL" => rule.interval = v.parse().ok().filter(|i| *i > 0)?,
            "UNTIL" => {
                let prop = crate::ical::Property::new("UNTIL", v.as_str());
                rule.until = Some(IcalTime::from_property(&prop)?);
            }
            "COUNT" => rule.count = Some(v.parse().ok().filter(|c| *c > 0)?),
            "BYDAY" => {
                for d in v.split(',') {
                    let d = d.trim();
                    let split = d.len().checked_sub(2)?;
                    let (ord, day) = d.split_at(split);
                    let ord = match ord.trim_start_matches('+') {
                        "" => 0,
                        n => n.parse::<i32>().ok().filter(|n| *n != 0 && n.abs() <= 53)?,
                    };
                    rule.byday.push((ord, weekday(day)?));
                }
            }
            "BYMONTHDAY" => rule.bymonthday = int_list(&v, |n| n != 0 && n.abs() <= 31)?,
            "BYMONTH" => {
                rule.bymonth = int_list(&v, |n| (1..=12).contains(&n))?.into_iter().map(|n| n as u32).collect()
            }
            "BYSETPOS" => rule.bysetpos = int_list(&v, |n| n != 0 && n.abs() <= 366)?,
            "FROM" if v == "COMPLETION" => rule.from_completion = true,
            "WKST" => {}
            _ => return None, // BYHOUR, BYWEEKNO, BYYEARDAY, …
        }
    }
    rule.freq = freq?;
    let ordinals = rule.byday.iter().any(|(o, _)| *o != 0);
    let supported = match rule.freq {
        Freq::Daily | Freq::Weekly => !ordinals && rule.bysetpos.is_empty() && (rule.freq == Freq::Daily || rule.bymonthday.is_empty()),
        Freq::Monthly => true,
        // Ordinals are only understood within a month.
        Freq::Yearly => rule.byday.is_empty() || !rule.bymonth.is_empty(),
    };
    supported.then_some(rule)
}

/// Computes the next occurrence after `current`, skipping occurrences that
/// fall before `not_before` (so an overdue daily task lands on today).
pub fn advance(rrule: &str, current: IcalTime, not_before: NaiveDate) -> Advance {
    let Some(rule) = parse_rrule(rrule) else { return Advance::Unsupported };
    let mut remaining = rule.count;
    let mut next = current;
    for _ in 0..5000 {
        if let Some(r) = remaining.as_mut() {
            if *r <= 1 {
                return Advance::Finished;
            }
            *r -= 1;
        }
        let Some(date) = next_date(&rule, next.local_date(), current.local_date()) else {
            return Advance::Unsupported;
        };
        next = next.add_days((date - next.local_date()).num_days());
        if let Some(until) = rule.until {
            if next.instant() > until.instant() && next.local_date() > until.local_date() {
                return Advance::Finished;
            }
        }
        if next.local_date() >= not_before {
            let rrule = match (rule.count, remaining) {
                (Some(old), Some(new)) if old != new => with_count(rrule, new),
                _ => rrule.to_string(),
            };
            return Advance::Next { at: next, rrule };
        }
    }
    Advance::Unsupported
}

/// Replaces the COUNT part, keeping everything else as written.
fn with_count(rrule: &str, count: u32) -> String {
    rrule
        .split(';')
        .map(|p| match p.split_once('=') {
            Some((k, _)) if k.trim().eq_ignore_ascii_case("COUNT") => format!("{}={count}", k.trim()),
            _ => p.to_string(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Splits our `FROM=COMPLETION` marker off a rule.
pub fn split_from_completion(rrule: &str) -> (String, bool) {
    let mut found = false;
    let parts: Vec<&str> = rrule
        .split(';')
        .filter(|p| {
            let is = p.trim().eq_ignore_ascii_case(FROM_COMPLETION);
            found |= is;
            !is && !p.trim().is_empty()
        })
        .collect();
    (parts.join(";"), found)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1).map_or(31, |d| (d - Duration::days(1)).day())
}

fn add_months(year: i32, month: u32, n: u32) -> (i32, u32) {
    let idx = year as i64 * 12 + (month as i64 - 1) + n as i64;
    ((idx.div_euclid(12)) as i32, (idx.rem_euclid(12) + 1) as u32)
}

fn byday_matches(rule: &Rule, d: NaiveDate) -> bool {
    rule.byday.iter().any(|&(ord, wd)| {
        if d.weekday() != wd {
            return false;
        }
        let nth = (d.day() as i32 - 1) / 7 + 1;
        let nth_from_end = (days_in_month(d.year(), d.month()) as i32 - d.day() as i32) / 7 + 1;
        ord == 0 || ord == nth || ord == -nth_from_end
    })
}

fn filters_pass(rule: &Rule, d: NaiveDate) -> bool {
    (rule.bymonth.is_empty() || rule.bymonth.contains(&d.month()))
        && (rule.bymonthday.is_empty() || {
            let dim = days_in_month(d.year(), d.month()) as i32;
            rule.bymonthday.iter().any(|&n| if n > 0 { n == d.day() as i32 } else { dim + 1 + n == d.day() as i32 })
        })
        && (rule.byday.is_empty() || byday_matches(rule, d))
}

/// The candidate days of one month for MONTHLY/YEARLY rules.
fn month_days(rule: &Rule, year: i32, month: u32, anchor_day: u32) -> Vec<NaiveDate> {
    let dim = days_in_month(year, month);
    let day = |d: u32| NaiveDate::from_ymd_opt(year, month, d);
    if rule.bymonthday.is_empty() && rule.byday.is_empty() {
        // "Every month" on the 31st lands on the last day of shorter months.
        return day(anchor_day.min(dim)).into_iter().collect();
    }
    (1..=dim).filter_map(day).filter(|d| filters_pass(rule, *d)).collect()
}

fn apply_setpos(rule: &Rule, mut days: Vec<NaiveDate>) -> Vec<NaiveDate> {
    days.sort();
    days.dedup();
    if rule.bysetpos.is_empty() {
        return days;
    }
    let len = days.len() as i32;
    let mut out: Vec<NaiveDate> = rule
        .bysetpos
        .iter()
        .filter_map(|&p| {
            let idx = if p > 0 { p - 1 } else { len + p };
            (0..len).contains(&idx).then(|| days[idx as usize])
        })
        .collect();
    out.sort();
    out
}

/// The first occurrence date strictly after `after`. `anchor` is the date
/// the series is measured from (it decides the day of month and the weeks
/// that count for INTERVAL).
fn next_date(rule: &Rule, after: NaiveDate, anchor: NaiveDate) -> Option<NaiveDate> {
    let n = rule.interval;
    match rule.freq {
        Freq::Daily => {
            let mut d = after;
            for _ in 0..3000 {
                d += Duration::days(n as i64);
                if filters_pass(rule, d) {
                    return Some(d);
                }
            }
            None
        }
        Freq::Weekly => {
            let week0 = monday_of(anchor);
            let days: Vec<Weekday> = if rule.byday.is_empty() {
                vec![anchor.weekday()]
            } else {
                rule.byday.iter().map(|(_, w)| *w).collect()
            };
            for offset in 1..=(7 * 60 * n as i64) {
                let d = after + Duration::days(offset);
                let weeks = (monday_of(d) - week0).num_days() / 7;
                if weeks.rem_euclid(n as i64) == 0 && days.contains(&d.weekday()) && filters_pass_month(rule, d) {
                    return Some(d);
                }
            }
            None
        }
        Freq::Monthly => {
            for period in 0..1200 {
                let (y, m) = add_months(after.year(), after.month(), period * n);
                if !rule.bymonth.is_empty() && !rule.bymonth.contains(&m) {
                    continue;
                }
                let days = apply_setpos(rule, month_days(rule, y, m, anchor.day()));
                if let Some(d) = days.into_iter().find(|d| *d > after) {
                    return Some(d);
                }
            }
            None
        }
        Freq::Yearly => {
            for period in 0..200 {
                let year = after.year() + (period * n) as i32;
                let months: Vec<u32> = if !rule.bymonth.is_empty() {
                    rule.bymonth.clone()
                } else if !rule.bymonthday.is_empty() {
                    (1..=12).collect()
                } else {
                    vec![anchor.month()]
                };
                let days: Vec<NaiveDate> =
                    months.iter().flat_map(|&m| month_days(rule, year, m, anchor.day())).collect();
                if let Some(d) = apply_setpos(rule, days).into_iter().find(|d| *d > after) {
                    return Some(d);
                }
            }
            None
        }
    }
}

fn filters_pass_month(rule: &Rule, d: NaiveDate) -> bool {
    rule.bymonth.is_empty() || rule.bymonth.contains(&d.month())
}

fn monday_of(d: NaiveDate) -> NaiveDate {
    d - Duration::days(d.weekday().num_days_from_monday() as i64)
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
    /// The next occurrence as a UI string, or "finished" / "unsupported".
    fn next(rule: &str, from: &str) -> String {
        match advance(rule, date(from), d("2000-01-01")) {
            Advance::Next { at, .. } => at.to_ui(),
            Advance::Finished => "finished".into(),
            Advance::Unsupported => "unsupported".into(),
        }
    }

    #[test]
    fn simple_frequencies() {
        assert_eq!(next("FREQ=DAILY", "2026-10-04"), "2026-10-05");
        assert_eq!(next("FREQ=DAILY;INTERVAL=3", "2026-10-04"), "2026-10-07");
        assert_eq!(next("FREQ=WEEKLY", "2026-10-04"), "2026-10-11");
        assert_eq!(next("FREQ=MONTHLY", "2026-01-31"), "2026-02-28");
        assert_eq!(next("FREQ=MONTHLY;INTERVAL=3", "2026-11-15"), "2027-02-15");
        assert_eq!(next("FREQ=YEARLY", "2028-02-29"), "2029-02-28");
        assert_eq!(next("FREQ=WEEKLY", "2026-10-04T09:30:00"), "2026-10-11T09:30:00");
    }

    #[test]
    fn weekdays() {
        let rule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
        assert_eq!(next(rule, "2026-10-02"), "2026-10-05"); // Fri -> Mon
        assert_eq!(next(rule, "2026-10-05"), "2026-10-06"); // Mon -> Tue
        assert_eq!(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-10-05"), "2026-10-19");
        assert_eq!(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "2026-10-05"), "2026-10-08");
        assert_eq!(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "2026-10-08"), "2026-10-19");
        assert_eq!(next("FREQ=DAILY;BYDAY=SA,SU", "2026-10-04"), "2026-10-10");
    }

    #[test]
    fn monthly_patterns() {
        // 15th of every month
        assert_eq!(next("FREQ=MONTHLY;BYMONTHDAY=15", "2026-10-04"), "2026-10-15");
        assert_eq!(next("FREQ=MONTHLY;BYMONTHDAY=15", "2026-10-15"), "2026-11-15");
        // Last day of the month
        assert_eq!(next("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-31"), "2026-02-28");
        // Last Friday of the month
        assert_eq!(next("FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30"), "2026-11-27");
        // Second Tuesday
        assert_eq!(next("FREQ=MONTHLY;BYDAY=2TU", "2026-10-13"), "2026-11-10");
        // First Monday every other month
        assert_eq!(next("FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO", "2026-10-05"), "2026-12-07");
        // Last weekday of the month
        assert_eq!(next("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-10-30"), "2026-11-30");
        assert_eq!(next("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-11-30"), "2026-12-31");
        // A 31st only exists in some months; skipped where missing.
        assert_eq!(next("FREQ=MONTHLY;BYMONTHDAY=31", "2026-01-31"), "2026-03-31");
    }

    #[test]
    fn yearly_patterns() {
        assert_eq!(next("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "2026-11-26"), "2027-11-25"); // Thanksgiving
        assert_eq!(next("FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1", "2026-03-01"), "2026-09-01");
        assert_eq!(next("FREQ=YEARLY;BYDAY=1MO", "2026-01-05"), "unsupported");
    }

    #[test]
    fn count_counts_down() {
        match advance("FREQ=WEEKLY;COUNT=3", date("2026-10-04"), d("2000-01-01")) {
            Advance::Next { at, rrule } => {
                assert_eq!(at.to_ui(), "2026-10-11");
                assert_eq!(rrule, "FREQ=WEEKLY;COUNT=2");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(next("FREQ=WEEKLY;COUNT=1", "2026-10-04"), "finished");
        // Skipped (missed) occurrences use up the count too.
        assert_eq!(advance("FREQ=DAILY;COUNT=3", date("2026-09-01"), d("2026-10-04")), Advance::Finished);
    }

    #[test]
    fn skips_missed_occurrences() {
        match advance("FREQ=DAILY", date("2026-09-01"), d("2026-10-04")) {
            Advance::Next { at, .. } => assert_eq!(at.to_ui(), "2026-10-04"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn until_and_unsupported() {
        assert_eq!(next("FREQ=DAILY;UNTIL=20261004", "2026-10-04"), "finished");
        assert_eq!(next("FREQ=HOURLY", "2026-10-04"), "unsupported");
        assert_eq!(next("FREQ=DAILY;BYHOUR=9", "2026-10-04"), "unsupported");
        assert_eq!(next("FREQ=WEEKLY;BYDAY=2MO", "2026-10-04"), "unsupported");
    }

    #[test]
    fn from_completion_marker() {
        assert!(parse_rrule("FREQ=DAILY;INTERVAL=3;FROM=COMPLETION").unwrap().from_completion);
        assert_eq!(split_from_completion("FREQ=DAILY;FROM=COMPLETION;INTERVAL=3"), ("FREQ=DAILY;INTERVAL=3".into(), true));
        assert_eq!(split_from_completion("FREQ=DAILY"), ("FREQ=DAILY".into(), false));
    }
}
