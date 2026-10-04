import {
  addDays,
  differenceInCalendarDays,
  format,
  isSameYear,
  nextMonday,
  startOfDay,
} from "date-fns";

/** A due value as stored by the backend. */
export interface DueInfo {
  date: Date;
  /** false for all-day values */
  hasTime: boolean;
}

export function parseDue(due: string | null | undefined): DueInfo | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const [y, m, d] = due.split("-").map(Number);
    return { date: new Date(y, m - 1, d), hasTime: false };
  }
  // With "Z" this is UTC, without it a floating local time; Date handles both.
  const date = new Date(due);
  return Number.isNaN(date.getTime()) ? null : { date, hasTime: true };
}

export function dateOnly(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/** Builds the backend representation; `time` is "HH:mm" or null for all-day. */
export function toDue(day: Date, time: string | null): string {
  if (!time) return dateOnly(day);
  const [h, m] = time.split(":").map(Number);
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function dueTime(info: DueInfo | null): string | null {
  return info?.hasTime ? format(info.date, "HH:mm") : null;
}

export function daysFromToday(info: DueInfo, now = new Date()): number {
  return differenceInCalendarDays(info.date, now);
}

export function isOverdue(info: DueInfo | null, now = new Date()): boolean {
  if (!info) return false;
  if (info.hasTime) return info.date.getTime() < now.getTime();
  return startOfDay(info.date).getTime() < startOfDay(now).getTime();
}

export function isDueToday(info: DueInfo | null, now = new Date()): boolean {
  return !!info && daysFromToday(info, now) === 0;
}

/** "Today", "Tomorrow 14:30", "Fri", "12 Oct", "12 Oct 2027" */
export function formatDue(info: DueInfo, now = new Date()): string {
  const days = daysFromToday(info, now);
  let label: string;
  if (days === 0) label = "Today";
  else if (days === 1) label = "Tomorrow";
  else if (days === -1) label = "Yesterday";
  else if (days > 1 && days < 7) label = format(info.date, "EEEE");
  else if (isSameYear(info.date, now)) label = format(info.date, "d MMM");
  else label = format(info.date, "d MMM yyyy");
  return info.hasTime ? `${label} ${format(info.date, "HH:mm")}` : label;
}

export function formatDayHeading(day: Date, now = new Date()): string {
  const days = differenceInCalendarDays(day, now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) return format(day, "EEEE");
  return isSameYear(day, now) ? format(day, "EEEE, d MMMM") : format(day, "EEEE, d MMMM yyyy");
}

export function formatTimestamp(value: string | null): string | null {
  const info = parseDue(value);
  if (!info) return null;
  return info.hasTime ? format(info.date, "d MMM yyyy, HH:mm") : format(info.date, "d MMM yyyy");
}

export const quickDates = (now = new Date()) => [
  { label: "Today", date: startOfDay(now) },
  { label: "Tomorrow", date: startOfDay(addDays(now, 1)) },
  { label: "Next week", date: startOfDay(nextMonday(now)) },
];

export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const secs = Math.round((now.getTime() - t) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return format(new Date(t), "d MMM, HH:mm");
}
