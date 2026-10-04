import { format } from "date-fns";

/** The parts of an RRULE that the repeat editor understands. */
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface RepeatRule {
  freq: Freq;
  interval: number;
  /** ordinal 0 = every such day */
  byday: { ord: number; day: Weekday }[];
  bymonthday: number[];
  bymonth: number[];
  bysetpos: number[];
  count: number | null;
  /** `YYYY-MM-DD` */
  until: string | null;
  /** Repeat relative to when the task was completed. */
  fromCompletion: boolean;
  /** Parts we don't edit, kept as written. */
  extra: string[];
}

export const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const WEEKDAY_NAMES: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last", [-2]: "second to last" };
const WORKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export function newRule(freq: Freq = "WEEKLY"): RepeatRule {
  return { freq, interval: 1, byday: [], bymonthday: [], bymonth: [], bysetpos: [], count: null, until: null, fromCompletion: false, extra: [] };
}

const ints = (v: string) => v.split(",").map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));

export function parseRule(input: string | null | undefined): RepeatRule | null {
  if (!input) return null;
  const r = newRule("DAILY");
  let freq: Freq | null = null;
  for (const part of input.replace(/^RRULE:/i, "").split(";")) {
    const [k, raw = ""] = part.split("=");
    const key = k.trim().toUpperCase();
    const v = raw.trim().toUpperCase();
    if (!key) continue;
    switch (key) {
      case "FREQ":
        if (v === "DAILY" || v === "WEEKLY" || v === "MONTHLY" || v === "YEARLY") freq = v;
        else return null;
        break;
      case "INTERVAL":
        r.interval = Math.max(1, parseInt(v, 10) || 1);
        break;
      case "COUNT":
        r.count = parseInt(v, 10) || null;
        break;
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
        r.until = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
        break;
      }
      case "BYDAY":
        for (const d of v.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d.trim());
          if (!m) return null;
          r.byday.push({ ord: m[1] ? parseInt(m[1], 10) : 0, day: m[2] as Weekday });
        }
        break;
      case "BYMONTHDAY":
        r.bymonthday = ints(v);
        break;
      case "BYMONTH":
        r.bymonth = ints(v);
        break;
      case "BYSETPOS":
        r.bysetpos = ints(v);
        break;
      case "FROM":
        if (v === "COMPLETION") r.fromCompletion = true;
        else r.extra.push(part.trim());
        break;
      default:
        r.extra.push(part.trim());
    }
  }
  if (!freq) return null;
  r.freq = freq;
  return r;
}

export function buildRule(r: RepeatRule): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.bymonth.length) parts.push(`BYMONTH=${r.bymonth.join(",")}`);
  if (r.byday.length) parts.push(`BYDAY=${r.byday.map((d) => `${d.ord || ""}${d.day}`).join(",")}`);
  if (r.bymonthday.length) parts.push(`BYMONTHDAY=${r.bymonthday.join(",")}`);
  if (r.bysetpos.length) parts.push(`BYSETPOS=${r.bysetpos.join(",")}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  else if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}`);
  parts.push(...r.extra);
  if (r.fromCompletion) parts.push("FROM=COMPLETION");
  return parts.join(";");
}

const UNIT: Record<Freq, [string, string]> = {
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

export function ordinalDay(n: number): string {
  if (n === -1) return "last day";
  if (n < 0) return `${-n}${suffix(-n)} to last day`;
  return `${n}${suffix(n)}`;
}

function suffix(n: number) {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
}

const isWorkdays = (days: Weekday[]) => days.length === 5 && WORKDAYS.every((d) => days.includes(d));
const shortDay = (d: Weekday) => WEEKDAY_NAMES[d].slice(0, 3);

/** The day pattern within a month ("the 15th", "the last Friday"), if any. */
function monthPattern(r: RepeatRule): string | null {
  const days = r.byday.map((d) => d.day);
  if (r.bysetpos.length === 1 && r.byday.every((d) => d.ord === 0) && days.length) {
    const what = isWorkdays(days) ? "weekday" : days.length === 1 ? WEEKDAY_NAMES[days[0]] : days.map(shortDay).join("/");
    return `the ${ORDINALS[r.bysetpos[0]] ?? r.bysetpos[0]} ${what}`;
  }
  if (r.byday.length && r.byday.every((d) => d.ord !== 0)) {
    return r.byday.map((d) => `the ${ORDINALS[d.ord] ?? d.ord} ${WEEKDAY_NAMES[d.day]}`).join(" and ");
  }
  if (r.bymonthday.length && !r.byday.length) return `the ${r.bymonthday.map(ordinalDay).join(" and ")}`;
  return null;
}

/** "Every 2 weeks on Mon, Thu", "Every month on the last Friday", … */
export function describeRule(input: string | null | undefined): string | null {
  if (!input) return null;
  const r = parseRule(input);
  if (!r) return "Custom repeat";
  const [one, many] = UNIT[r.freq];
  let text = r.interval > 1 ? `Every ${r.interval} ${many}` : `Every ${one}`;
  const days = r.byday.map((d) => d.day);
  if (r.freq === "DAILY" && r.interval === 1 && isWorkdays(days)) text = "Every weekday";
  else if (r.freq === "WEEKLY" && days.length) {
    if (r.interval === 1 && isWorkdays(days)) text = "Every weekday";
    else text += ` on ${days.map(shortDay).join(", ")}`;
  } else if (r.freq === "MONTHLY") {
    const p = monthPattern(r);
    if (p) text += ` on ${p}`;
  } else if (r.freq === "YEARLY") {
    const months = r.bymonth.map((m) => MONTH_NAMES[m - 1]).filter(Boolean);
    const p = monthPattern(r);
    if (p && months.length) {
      text += r.bymonthday.length && !r.byday.length && r.bymonthday.length === 1 && r.bymonthday[0] > 0
        ? ` on ${r.bymonthday[0]} ${months.join(", ")}`
        : ` on ${p} of ${months.join(", ")}`;
    } else if (months.length) text += ` in ${months.join(", ")}`;
  }
  if (r.extra.length) return "Custom repeat";
  if (r.fromCompletion) text += " after completion";
  if (r.count) text += r.count === 1 ? ", once more" : `, ${r.count} times`;
  else if (r.until) {
    const [y, m, d] = r.until.split("-").map(Number);
    text += `, until ${format(new Date(y, m - 1, d), "d MMM yyyy")}`;
  }
  return text;
}

/** RRULE weekday for a date. */
export function weekdayOf(d: Date): Weekday {
  return WEEKDAYS[(d.getDay() + 6) % 7];
}

/** Which occurrence of its weekday a date is within its month (1…5, or -1 for the last). */
export function weekOfMonth(d: Date): { nth: number; last: boolean } {
  const nth = Math.floor((d.getDate() - 1) / 7) + 1;
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { nth, last: d.getDate() + 7 > dim };
}

/**
 * The first day on or after `from` that matches a rule's day pattern, used to
 * give "every last Friday" a sensible first due date.
 */
export function firstOccurrence(input: string, from: Date): Date {
  const r = parseRule(input);
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  if (!r || (!r.byday.length && !r.bymonthday.length)) return start;
  for (let i = 0; i < 400; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (matchesDay(r, d)) return d;
  }
  return start;
}

function matchesDay(r: RepeatRule, d: Date): boolean {
  if (r.bymonth.length && !r.bymonth.includes(d.getMonth() + 1)) return false;
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (r.bymonthday.length && !r.bymonthday.some((n) => (n > 0 ? n : dim + 1 + n) === d.getDate())) return false;
  if (r.byday.length) {
    const wd = weekdayOf(d);
    const nth = Math.floor((d.getDate() - 1) / 7) + 1;
    const fromEnd = Math.floor((dim - d.getDate()) / 7) + 1;
    const ok = r.byday.some((b) => b.day === wd && (b.ord === 0 || b.ord === nth || b.ord === -fromEnd));
    if (!ok) return false;
    if (r.bysetpos.length) {
      // Only the common "last/first weekday of the month" style is checked.
      const sameMonth = Array.from({ length: dim }, (_, i) => new Date(d.getFullYear(), d.getMonth(), i + 1)).filter((x) =>
        r.byday.some((b) => b.day === weekdayOf(x)),
      );
      const idx = sameMonth.findIndex((x) => x.getDate() === d.getDate());
      return r.bysetpos.some((p) => (p > 0 ? p - 1 : sameMonth.length + p) === idx);
    }
  }
  return true;
}
