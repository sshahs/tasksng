import { addDays, format, isSameDay, startOfDay } from "date-fns";

import { isDueToday, isOverdue, parseDue } from "./dates";
import { startsLater } from "./search";
import { isSnoozed } from "./snooze";
import type { Task, TaskList } from "./types";
import { isInView, plannedOn } from "./views";

/** Numbers for the Overview: how things stand and how the last days went. */
export interface Overview {
  open: number;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
  completedToday: number;
  completedThisWeek: number;
  /** Consecutive days (ending today or yesterday) with at least one completed task. */
  streak: number;
  /** Completed per day for the last 14 days, oldest first. */
  perDay: { day: Date; label: string; count: number }[];
  /** Open tasks per list, largest first. */
  byList: { list: TaskList; count: number }[];
  snoozed: number;
  unplanned: number;
}

const dayKey = (d: Date) => format(d, "yyyy-MM-dd");

export function overview(tasks: Task[], lists: TaskList[], now = new Date()): Overview {
  const today = startOfDay(now);
  const open = tasks.filter((t) => !t.completed);
  const done = new Map<string, number>();
  for (const t of tasks) {
    if (t.status !== "completed" || !t.completedAt) continue;
    const d = new Date(t.completedAt);
    if (Number.isNaN(d.getTime())) continue;
    done.set(dayKey(d), (done.get(dayKey(d)) ?? 0) + 1);
  }
  let streak = 0;
  let day = done.get(dayKey(today)) ? today : addDays(today, -1);
  while (done.get(dayKey(day))) {
    streak++;
    day = addDays(day, -1);
  }
  const current = open.filter((t) => !isSnoozed(t, now) && !startsLater(t, now));
  const perList = new Map<string, number>();
  for (const t of current) perList.set(t.listId, (perList.get(t.listId) ?? 0) + 1);
  const week = addDays(today, 6).getTime();
  return {
    open: current.length,
    overdue: current.filter((t) => {
      const d = parseDue(t.due);
      return isOverdue(d, now) && !isDueToday(d, now);
    }).length,
    dueToday: current.filter((t) => isDueToday(parseDue(t.due), now)).length,
    dueThisWeek: current.filter((t) => {
      const d = parseDue(t.due);
      return !!d && startOfDay(d.date).getTime() >= today.getTime() && startOfDay(d.date).getTime() <= week;
    }).length,
    completedToday: done.get(dayKey(today)) ?? 0,
    completedThisWeek: Array.from({ length: 7 }, (_, i) => done.get(dayKey(addDays(today, -i))) ?? 0).reduce((a, b) => a + b, 0),
    streak,
    perDay: Array.from({ length: 14 }, (_, i) => {
      const d = addDays(today, i - 13);
      return { day: d, label: format(d, "EEEEE"), count: done.get(dayKey(d)) ?? 0 };
    }),
    byList: lists
      .map((list) => ({ list, count: perList.get(list.id) ?? 0 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count),
    snoozed: open.filter((t) => isSnoozed(t, now)).length,
    unplanned: current.filter((t) => isInView("today", t, {}, now) && !plannedOn(t, now)).length,
  };
}

export { isSameDay };
