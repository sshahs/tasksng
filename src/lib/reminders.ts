import { addDays, addHours, nextMonday, setHours, setMinutes, startOfDay, startOfHour } from "date-fns";

import { formatDue, parseDue } from "./dates";
import type { Reminder, Task } from "./types";

type Dates = Pick<Task, "due" | "start">;

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "15 minutes", "1 hour 30 minutes", "2 days", "1 week" */
export function humanDuration(secs: number): string {
  const s = Math.abs(secs);
  if (s === 0) return "0 minutes";
  if (s % WEEK === 0) return plural(s / WEEK, "week");
  if (s % DAY === 0) return plural(s / DAY, "day");
  const parts: string[] = [];
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  const m = Math.floor((s % HOUR) / MIN);
  if (d) parts.push(plural(d, "day"));
  if (h) parts.push(plural(h, "hour"));
  if (m) parts.push(plural(m, "minute"));
  return parts.join(" ") || plural(s, "second");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** When a reminder goes off for a task, if that can be worked out. */
export function reminderTime(r: Reminder, task: Dates): Date | null {
  if ("at" in r) {
    const d = new Date(r.at);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const field = r.related === "start" ? (task.start ?? task.due) : (task.due ?? task.start);
  const anchor = parseDue(field);
  if (!anchor) return null;
  // Whole days are calendar days; for all-day and floating dates the rest is
  // wall-clock time too (the Date constructor normalises in local time).
  if (!anchor.hasTime || !field!.endsWith("Z")) {
    const b = anchor.hasTime ? anchor.date : startOfDay(anchor.date);
    return new Date(b.getFullYear(), b.getMonth(), b.getDate(), b.getHours(), b.getMinutes(), b.getSeconds() + r.offset);
  }
  const days = Math.trunc(r.offset / DAY);
  const d = new Date(anchor.date);
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() + (r.offset - days * DAY) * 1000);
}

export function reminderLabel(r: Reminder, task: Dates, now = new Date()): string {
  if ("at" in r) {
    const d = reminderTime(r, task);
    return d ? formatDue({ date: d, hasTime: true }, now) : "Reminder";
  }
  const anchorField = r.related === "start" && task.start ? task.start : (task.due ?? task.start);
  const anchor = parseDue(anchorField);
  const what = r.related === "start" && task.start ? "start" : "due";
  if (anchor && !anchor.hasTime) {
    // All-day: "On the day at 09:00", "Day before at 09:00", "2 days before at 09:00".
    const days = Math.floor(r.offset / DAY);
    const rest = r.offset - days * DAY;
    const time = `${pad(Math.floor(rest / HOUR))}:${pad(Math.floor((rest % HOUR) / MIN))}`;
    const day = days === 0 ? "On the day" : days === -1 ? "Day before" : days < 0 ? `${-days} days before` : `${plural(days, "day")} after`;
    return `${day} at ${time}`;
  }
  if (r.offset === 0) return what === "start" ? "At start time" : "At due time";
  return `${humanDuration(r.offset)} ${r.offset < 0 ? "before" : "after"}${what === "start" ? " start" : ""}`;
}

export interface ReminderPreset {
  label: string;
  reminder: Reminder;
}

/** Suggestions that fit the task's due date (or fixed times without one). */
export function reminderPresets(task: Dates, now = new Date()): ReminderPreset[] {
  const due = parseDue(task.due);
  const rel = (offset: number): Reminder => ({ offset, related: "due" });
  if (due?.hasTime) {
    return [0, -5 * MIN, -15 * MIN, -30 * MIN, -HOUR, -DAY].map((o) => ({ label: reminderLabel(rel(o), task, now), reminder: rel(o) }));
  }
  if (due) {
    return [9 * HOUR, -15 * HOUR, -2 * DAY + 9 * HOUR, -WEEK + 9 * HOUR].map((o) => ({
      label: reminderLabel(rel(o), task, now),
      reminder: rel(o),
    }));
  }
  const at = (d: Date): Reminder => ({ at: d.toISOString().replace(/\.\d{3}Z$/, "Z") });
  const inAnHour = startOfHour(addHours(now, 2));
  const evening = setMinutes(setHours(startOfDay(now), 18), 0);
  const tomorrow = setHours(startOfDay(addDays(now, 1)), 9);
  const monday = setHours(startOfDay(nextMonday(now)), 9);
  const out = [inAnHour, ...(evening > inAnHour ? [evening] : []), tomorrow, ...(monday > tomorrow ? [monday] : [])];
  return out.map((d) => ({ label: formatDue({ date: d, hasTime: true }, now), reminder: at(d) }));
}

export function sameReminder(a: Reminder, b: Reminder): boolean {
  if ("at" in a && "at" in b) return new Date(a.at).getTime() === new Date(b.at).getTime();
  if ("offset" in a && "offset" in b) return a.offset === b.offset && a.related === b.related;
  return false;
}

/** Labels for the automatic reminder setting. */
export const DEFAULT_REMINDERS: { value: string; label: string; offset: number | null }[] = [
  { value: "off", label: "No automatic reminder", offset: null },
  { value: "0", label: "At the due time", offset: 0 },
  { value: "-300", label: "5 minutes before", offset: -300 },
  { value: "-900", label: "15 minutes before", offset: -900 },
  { value: "-1800", label: "30 minutes before", offset: -1800 },
  { value: "-3600", label: "1 hour before", offset: -3600 },
];
