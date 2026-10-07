import { addDays, format, isSameDay, nextMonday, nextSaturday, setHours, startOfDay } from "date-fns";

import type { Task } from "./types";

export interface SnoozePreset {
  id: string;
  label: string;
  /** When, as shown next to the label ("18:15", "Sat 09:00"). */
  hint: string;
  at: Date;
}

const MORNING = 9;
const EVENING = 19;

function at(day: Date, hour: number): Date {
  return setHours(startOfDay(day), hour);
}

/** The usual choices, only those that make sense right now. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const out: SnoozePreset[] = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  later.setMinutes(Math.ceil(later.getMinutes() / 15) * 15, 0, 0);
  if (isSameDay(later, now) && later.getHours() < 21) {
    out.push({ id: "later", label: "Later today", hint: format(later, "HH:mm"), at: later });
  }
  if (now.getHours() < EVENING - 2) {
    out.push({ id: "evening", label: "This evening", hint: format(at(now, EVENING), "HH:mm"), at: at(now, EVENING) });
  }
  const tomorrow = at(addDays(now, 1), MORNING);
  out.push({ id: "tomorrow", label: "Tomorrow", hint: format(tomorrow, "EEE HH:mm"), at: tomorrow });
  const day = now.getDay();
  if (day >= 1 && day <= 4) {
    const weekend = at(nextSaturday(now), MORNING);
    out.push({ id: "weekend", label: "This weekend", hint: format(weekend, "EEE HH:mm"), at: weekend });
  }
  const week = at(nextMonday(now), MORNING);
  out.push({ id: "week", label: "Next week", hint: format(week, "EEE d MMM"), at: week });
  return out;
}

/** Hidden for now: snoozed until a later moment. */
export function isSnoozed(t: Task, now = new Date()): boolean {
  return !!t.snoozedUntil && new Date(t.snoozedUntil).getTime() > now.getTime();
}

/** The next moment a snoozed task comes back, if any. */
export function nextWake(tasks: Iterable<Task>, now = new Date()): Date | null {
  let next: number | null = null;
  for (const t of tasks) {
    if (!t.snoozedUntil || t.completed) continue;
    const ms = new Date(t.snoozedUntil).getTime();
    if (ms > now.getTime() && (next === null || ms < next)) next = ms;
  }
  return next === null ? null : new Date(next);
}

/** "until 18:15", "until tomorrow 09:00", "until Mon 13 Oct 09:00". */
export function snoozeLabel(until: string, now = new Date()): string {
  const d = new Date(until);
  if (isSameDay(d, now)) return `until ${format(d, "HH:mm")}`;
  if (isSameDay(d, addDays(now, 1))) return `until tomorrow ${format(d, "HH:mm")}`;
  if (d.getTime() - now.getTime() < 6 * 86_400_000) return `until ${format(d, "EEE HH:mm")}`;
  return `until ${format(d, "EEE d MMM HH:mm")}`;
}
