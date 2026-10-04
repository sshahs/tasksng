import { addDays, addWeeks, nextMonday, startOfDay } from "date-fns";

import { toDue } from "./dates";

export interface QuickAddResult {
  summary: string;
  due: string | null;
  priority: number | null;
  categories: string[];
  rrule: string | null;
}

const B = "(^|\\s)";
const E = "(?=\\s|$)";

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const RRULES: Record<string, string> = {
  daily: "FREQ=DAILY", "every day": "FREQ=DAILY",
  weekly: "FREQ=WEEKLY", "every week": "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY", "every month": "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY", "every year": "FREQ=YEARLY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "every weekday": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
};

function take(text: string, re: RegExp): [string, RegExpExecArray | null] {
  const m = re.exec(text);
  if (!m) return [text, null];
  return [text.slice(0, m.index) + " " + text.slice(m.index + m[0].length), m];
}

/**
 * Parses quick-add shortcuts out of a task title:
 * `Pay rent tomorrow 9am !1 #home every month`.
 */
export function parseQuickAdd(input: string, now = new Date()): QuickAddResult {
  const plain: QuickAddResult = { summary: input.trim(), due: null, priority: null, categories: [], rrule: null };
  let text = ` ${input} `;
  let priority: number | null = null;
  let rrule: string | null = null;
  let day: Date | null = null;
  let time: string | null = null;
  const categories: string[] = [];
  let m: RegExpExecArray | null;

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

  [text, m] = take(text, new RegExp(`${B}(every\\s+(?:day|week|month|year|weekday)|daily|weekly|monthly|yearly|weekdays)${E}`, "i"));
  if (m) rrule = RRULES[m[2].toLowerCase().replace(/\s+/g, " ")];

  [text, m] = take(text, new RegExp(`${B}(?:at\\s+)?(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm)${E}`, "i"));
  if (m) {
    let h = Number(m[2]) % 12;
    if (m[4].toLowerCase() === "pm") h += 12;
    time = `${String(h).padStart(2, "0")}:${m[3] ?? "00"}`;
  } else {
    [text, m] = take(text, new RegExp(`${B}(?:at\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)${E}`, "i"));
    if (m) time = `${m[2].padStart(2, "0")}:${m[3]}`;
  }

  const today = startOfDay(now);
  [text, m] = take(text, new RegExp(`${B}(today|tod|tomorrow|tmr|tmrw|next week)${E}`, "i"));
  if (m) {
    const w = m[2].toLowerCase();
    day = w.startsWith("tod") ? today : w === "next week" ? nextMonday(today) : addDays(today, 1);
  } else {
    [text, m] = take(text, new RegExp(`${B}in\\s+(\\d{1,3})\\s+(days?|weeks?)${E}`, "i"));
    if (m) {
      const n = Number(m[2]);
      day = m[3].toLowerCase().startsWith("week") ? addWeeks(today, n) : addDays(today, n);
    } else {
      [text, m] = take(text, new RegExp(`${B}(?:on\\s+|next\\s+)?(${Object.keys(WEEKDAYS).join("|")})${E}`, "i"));
      if (m) {
        const target = WEEKDAYS[m[2].toLowerCase()];
        let diff = (target - today.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        day = addDays(today, diff);
      } else {
        [text, m] = take(text, new RegExp(`${B}(\\d{4})-(\\d{2})-(\\d{2})${E}`));
        if (m) {
          const d = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4]));
          if (!Number.isNaN(d.getTime())) day = d;
        }
      }
    }
  }

  const summary = text.replace(/\s+/g, " ").trim();
  if (!summary) return plain;
  if (!day && time) day = today;
  if (!day && rrule) day = today;
  return {
    summary,
    due: day ? toDue(day, time) : null,
    priority,
    categories,
    rrule,
  };
}
