import { addDays, addWeeks, nextMonday, startOfDay } from "date-fns";

import { toDue } from "./dates";
import { firstOccurrence } from "./rrule";

export interface QuickAddResult {
  summary: string;
  due: string | null;
  start: string | null;
  priority: number | null;
  categories: string[];
  rrule: string | null;
  /** `@name` — the start of a list's name. */
  list: string | null;
}

const B = "(^|\\s)";
const E = "(?=\\s|$)";

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const RRULE_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WD = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const ORDINAL: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 };

const SIMPLE_RRULES: Record<string, string> = {
  daily: "FREQ=DAILY", "every day": "FREQ=DAILY",
  weekly: "FREQ=WEEKLY", "every week": "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY", "every month": "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY", "every year": "FREQ=YEARLY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "every weekday": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
};
const FREQ: Record<string, string> = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" };

/** A day expression: today, tomorrow, next week, in 3 days, fri, next fri, 2026-12-01. */
const DAY = `(today|tod|tomorrow|tmrw?|next week|in\\s+\\d{1,3}\\s+(?:days?|weeks?)|(?:next\\s+)?(?:${WD})|\\d{4}-\\d{2}-\\d{2})`;

function take(text: string, re: RegExp): [string, RegExpExecArray | null] {
  const m = re.exec(text);
  if (!m) return [text, null];
  return [text.slice(0, m.index) + " " + text.slice(m.index + m[0].length), m];
}

function resolveDay(expr: string, today: Date): Date | null {
  const w = expr.toLowerCase().replace(/\s+/g, " ");
  if (w === "today" || w === "tod") return today;
  if (w.startsWith("tom") || w.startsWith("tmr")) return addDays(today, 1);
  if (w === "next week") return nextMonday(today);
  const rel = /^in (\d{1,3}) (days?|weeks?)$/.exec(w);
  if (rel) return rel[2].startsWith("week") ? addWeeks(today, Number(rel[1])) : addDays(today, Number(rel[1]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const target = WEEKDAYS[w.replace(/^next /, "")];
  if (target === undefined) return null;
  let diff = (target - today.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(today, diff);
}

function takeRecurrence(text: string): [string, string | null] {
  let m: RegExpExecArray | null;
  // every 3 days / every 2 weeks / every other month
  [text, m] = take(text, new RegExp(`${B}every\\s+(\\d{1,3}|other)\\s+(day|week|month|year)s?${E}`, "i"));
  if (m) {
    const n = m[2].toLowerCase() === "other" ? 2 : Math.max(1, Number(m[2]));
    return [text, `FREQ=${FREQ[m[3].toLowerCase()]}${n > 1 ? `;INTERVAL=${n}` : ""}`];
  }
  // every last friday / every first weekday (of the month)
  [text, m] = take(
    text,
    new RegExp(`${B}every\\s+(first|1st|second|2nd|third|3rd|fourth|4th|last)\\s+(weekday|${WD})(?:\\s+of\\s+the\\s+month)?${E}`, "i"),
  );
  if (m) {
    const ord = ORDINAL[m[2].toLowerCase()];
    const day = m[3].toLowerCase();
    return [text, day === "weekday" ? `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${ord}` : `FREQ=MONTHLY;BYDAY=${ord}${RRULE_DAY[WEEKDAYS[day]]}`];
  }
  // every 15th / every month on the 15th
  [text, m] = take(text, new RegExp(`${B}every\\s+(?:month\\s+on\\s+the\\s+)?(\\d{1,2})(?:st|nd|rd|th)(?:\\s+of\\s+the\\s+month)?${E}`, "i"));
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 31) return [text, `FREQ=MONTHLY;BYMONTHDAY=${Number(m[2])}`];
  // every monday / every tue and thu
  [text, m] = take(text, new RegExp(`${B}every\\s+((?:${WD})(?:\\s*(?:,|and|&)\\s*(?:${WD}))*)${E}`, "i"));
  if (m) {
    const days = m[2]
      .toLowerCase()
      .split(/\s*(?:,|and|&)\s*/)
      .map((d) => RRULE_DAY[WEEKDAYS[d.trim()]])
      .filter((d, i, all) => d && all.indexOf(d) === i);
    return [text, `FREQ=WEEKLY;BYDAY=${days.join(",")}`];
  }
  [text, m] = take(text, new RegExp(`${B}(every\\s+(?:day|week|month|year|weekday)|daily|weekly|monthly|yearly|weekdays)${E}`, "i"));
  if (m) return [text, SIMPLE_RRULES[m[2].toLowerCase().replace(/\s+/g, " ")]];
  return [text, null];
}

/**
 * Parses quick-add shortcuts out of a task title:
 * `Pay rent tomorrow 9am !1 #home @personal every month`.
 */
export function parseQuickAdd(input: string, now = new Date()): QuickAddResult {
  const plain: QuickAddResult = {
    summary: input.trim(),
    due: null,
    start: null,
    priority: null,
    categories: [],
    rrule: null,
    list: null,
  };
  let text = ` ${input} `;
  let priority: number | null = null;
  let rrule: string | null = null;
  let day: Date | null = null;
  let start: Date | null = null;
  let time: string | null = null;
  let list: string | null = null;
  const categories: string[] = [];
  let m: RegExpExecArray | null;
  const today = startOfDay(now);

  [text, m] = take(text, new RegExp(`${B}(!!!|!!|!(?:[1-3]|high|medium|med|low)?)${E}`, "i"));
  if (m) {
    const p = m[2].toLowerCase();
    priority = p === "!!!" || p === "!1" || p === "!high" ? 1 : p === "!!" || p === "!2" || p.startsWith("!med") ? 5 : 9;
  }

  const tagRe = new RegExp(`${B}#([\\p{L}\\p{N}_\\-/.]+)${E}`, "iu");
  for (;;) {
    [text, m] = take(text, tagRe);
    if (!m) break;
    if (!categories.includes(m[2])) categories.push(m[2]);
  }

  [text, m] = take(text, new RegExp(`${B}@([\\p{L}\\p{N}_\\-/.]+)${E}`, "iu"));
  if (m) list = m[2];

  [text, rrule] = takeRecurrence(text);
  if (rrule) {
    [text, m] = take(text, new RegExp(`${B}(?:after|from)\\s+(?:completion|completing|done)${E}`, "i"));
    if (m) rrule += ";FROM=COMPLETION";
  }

  [text, m] = take(text, new RegExp(`${B}(?:from|starting|starts)\\s+${DAY}${E}`, "i"));
  if (m) start = resolveDay(m[2], today);

  [text, m] = take(text, new RegExp(`${B}(?:at\\s+)?(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm)${E}`, "i"));
  if (m) {
    let h = Number(m[2]) % 12;
    if (m[4].toLowerCase() === "pm") h += 12;
    time = `${String(h).padStart(2, "0")}:${m[3] ?? "00"}`;
  } else {
    [text, m] = take(text, new RegExp(`${B}(?:at\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)${E}`, "i"));
    if (m) time = `${m[2].padStart(2, "0")}:${m[3]}`;
  }

  [text, m] = take(text, new RegExp(`${B}(?:on\\s+|due\\s+)?${DAY}${E}`, "i"));
  if (m) day = resolveDay(m[2], today);

  const summary = text.replace(/\s+/g, " ").trim();
  if (!summary) return plain;
  if (!day && time) day = today;
  // "every week from monday" starts the series on its start date.
  if (!day && rrule) day = firstOccurrence(rrule, start ?? today);
  return {
    summary,
    due: day ? toDue(day, time) : null,
    start: start ? toDue(start, null) : null,
    priority,
    categories,
    rrule,
    list,
  };
}

/** Finds the list an `@name` refers to: exact name, then prefix, then any match. */
export function resolveList<T extends { name: string }>(token: string | null, lists: T[]): T | null {
  if (!token) return null;
  const want = token.toLowerCase().replace(/[-_.]/g, " ");
  const squash = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, "");
  return (
    lists.find((l) => l.name.toLowerCase() === want) ??
    lists.find((l) => l.name.toLowerCase().startsWith(want)) ??
    lists.find((l) => squash(l.name).startsWith(squash(token))) ??
    lists.find((l) => l.name.toLowerCase().includes(want)) ??
    null
  );
}
