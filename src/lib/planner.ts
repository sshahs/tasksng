import { addDays, isSameDay, startOfDay } from "date-fns";

import { isDueToday, isOverdue, parseDue } from "./dates";
import { startsLater } from "./search";
import { isSnoozed } from "./snooze";
import type { CalEvent, Task } from "./types";
import { isInView, plannedOn } from "./views";

/** How long a task is planned for when nobody said. */
export const DEFAULT_MINUTES = 30;
/** Plans snap to quarter hours. */
export const STEP = 15;
const DAY = 24 * 60;

/** ISO strings for a local day, as the backend wants them (`from` inclusive, `to` exclusive). */
export function dayRange(day: Date): { from: string; to: string } {
  const start = startOfDay(day);
  return { from: iso(start), to: iso(addDays(start, 1)) };
}

/** A UTC instant without milliseconds, like the backend writes them. */
export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Minutes since local midnight of `day` (may be negative or past the end of the day). */
export function minutesInto(day: Date, at: Date): number {
  return Math.round((at.getTime() - startOfDay(day).getTime()) / 60_000);
}

/** The instant `minutes` after local midnight of `day`. */
export function atMinutes(day: Date, minutes: number): Date {
  const d = startOfDay(day);
  d.setMinutes(minutes);
  return d;
}

/** Nearest quarter hour, kept inside the day so a block always fits. */
export function snap(minutes: number, duration = 0): number {
  const s = Math.round(minutes / STEP) * STEP;
  return Math.max(0, Math.min(DAY - Math.max(duration, STEP), s));
}

export interface Slot {
  id: string;
  start: number;
  end: number;
}

/**
 * Side by side placement for overlapping blocks: each gets a column and the
 * number of columns of its group of overlapping blocks.
 */
export function layoutSlots(slots: Slot[]): Map<string, { col: number; cols: number }> {
  const sorted = [...slots].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const out = new Map<string, { col: number; cols: number }>();
  let group: { id: string; col: number }[] = [];
  let colEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const g of group) out.set(g.id, { col: g.col, cols: colEnds.length });
    group = [];
    colEnds = [];
  };
  for (const s of sorted) {
    const end = Math.max(s.end, s.start + STEP);
    if (s.start >= groupEnd) {
      flush();
      groupEnd = -Infinity;
    }
    let col = colEnds.findIndex((e) => e <= s.start);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(end);
    } else {
      colEnds[col] = end;
    }
    group.push({ id: s.id, col });
    groupEnd = Math.max(groupEnd, end);
  }
  flush();
  return out;
}

/** Tasks waiting to be planned on `day`: today's tasks for today, otherwise those due or starting then. */
export function trayTasks(all: Task[], day: Date, now = new Date()): Task[] {
  const today = isSameDay(day, now);
  const forDay = (t: Task) => {
    if (today) return isInView("today", t, {}, now);
    const due = parseDue(t.due);
    const start = parseDue(t.start);
    return (!!due && isSameDay(due.date, day)) || (!!start && isSameDay(start.date, day));
  };
  const rank = (t: Task) => {
    const due = parseDue(t.due);
    return isOverdue(due, now) && !isDueToday(due, now) ? 0 : 1;
  };
  return all
    .filter((t) => !t.completed && !isSnoozed(t, now) && !plannedOn(t, day) && !(today && startsLater(t, now)) && forDay(t))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.priority || 10) - (b.priority || 10) ||
        (parseDue(a.due)?.date.getTime() ?? Infinity) - (parseDue(b.due)?.date.getTime() ?? Infinity) ||
        a.summary.localeCompare(b.summary),
    );
}

/** Tasks planned on `day`, in time order. */
export function plannedTasks(all: Task[], day: Date): Task[] {
  return all.filter((t) => plannedOn(t, day)).sort((a, b) => (a.planned ?? "").localeCompare(b.planned ?? ""));
}

/** Minutes from `from` to `to` (clipped to the day) taken by timed events and open planned tasks. */
export function busyMinutes(day: Date, events: CalEvent[], tasks: Task[], from: number, to: number): number {
  const spans: [number, number][] = [];
  for (const e of events) {
    if (e.allDay) continue;
    spans.push([minutesInto(day, new Date(e.start)), minutesInto(day, new Date(e.end))]);
  }
  for (const t of tasks) {
    if (t.completed || !t.planned) continue;
    const s = minutesInto(day, new Date(t.planned));
    spans.push([s, s + (t.plannedMinutes ?? DEFAULT_MINUTES)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let cursor = from;
  for (const [s, e] of spans) {
    const start = Math.max(s, cursor);
    const end = Math.min(e, to);
    if (end > start) {
      busy += end - start;
      cursor = end;
    }
  }
  return busy;
}

/** "1 h 30 min", "45 min". */
export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} min`;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
