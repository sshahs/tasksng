import { describe, expect, it } from "vitest";

import { atMinutes, busyMinutes, dayRange, formatMinutes, iso, layoutSlots, minutesInto, snap, trayTasks } from "./planner";
import type { CalEvent, Task } from "./types";

const DAY = new Date(2026, 9, 6, 10, 0, 0);
let n = 0;
function task(p: Partial<Task>): Task {
  n++;
  return {
    id: `/l/${n}.ics`,
    uid: `u${n}`,
    listId: "/l/",
    summary: `Task ${n}`,
    description: "",
    status: "needs-action",
    completed: false,
    completedAt: null,
    priority: 0,
    due: null,
    start: null,
    categories: [],
    parentUid: null,
    rrule: null,
    created: null,
    modified: null,
    sortOrder: null,
    reminders: [],
    planned: null,
    plannedMinutes: null,
    snoozedUntil: null,
    pending: false,
    ...p,
  };
}

describe("planner", () => {
  it("works in local minutes of the day", () => {
    const { from, to } = dayRange(DAY);
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 3600_000);
    expect(minutesInto(DAY, atMinutes(DAY, 14 * 60 + 30))).toBe(870);
    expect(iso(new Date(Date.UTC(2026, 9, 6, 12, 0, 0, 123)))).toBe("2026-10-06T12:00:00Z");
  });

  it("snaps to quarter hours inside the day", () => {
    expect(snap(7 * 60 + 8)).toBe(7 * 60 + 15);
    expect(snap(-20)).toBe(0);
    expect(snap(24 * 60, 60)).toBe(23 * 60);
  });

  it("puts overlapping blocks side by side", () => {
    const l = layoutSlots([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 570, end: 630 },
      { id: "c", start: 600, end: 660 },
      { id: "d", start: 700, end: 720 },
    ]);
    expect(l.get("a")).toEqual({ col: 0, cols: 2 });
    expect(l.get("b")).toEqual({ col: 1, cols: 2 });
    expect(l.get("c")).toEqual({ col: 0, cols: 2 });
    expect(l.get("d")).toEqual({ col: 0, cols: 1 });
  });

  it("fills the tray with the day's unplanned tasks, overdue and important first", () => {
    const planned = task({ summary: "planned", due: "2026-10-06", planned: iso(atMinutes(DAY, 600)) });
    const tasks = [
      task({ summary: "today", due: "2026-10-06" }),
      task({ summary: "urgent", due: "2026-10-06", priority: 1 }),
      task({ summary: "late", due: "2026-10-01" }),
      task({ summary: "tomorrow", due: "2026-10-07" }),
      task({ summary: "done", due: "2026-10-06", completed: true, status: "completed" }),
      planned,
    ];
    expect(trayTasks(tasks, DAY, DAY).map((t) => t.summary)).toEqual(["late", "urgent", "today"]);
    const tomorrow = new Date(2026, 9, 7);
    expect(trayTasks(tasks, tomorrow, DAY).map((t) => t.summary)).toEqual(["tomorrow"]);
  });

  it("adds up busy time without counting overlaps twice", () => {
    const ev = (s: number, e: number): CalEvent => ({
      id: `${s}`,
      calendarId: "/c/",
      title: "x",
      start: iso(atMinutes(DAY, s)),
      end: iso(atMinutes(DAY, e)),
      allDay: false,
      location: null,
      color: null,
    });
    const t = task({ planned: iso(atMinutes(DAY, 630)), plannedMinutes: 60 });
    // 9:00–10:00, 9:30–10:30 and a task 10:30–11:30, counted from 9:30 to 11:00.
    expect(busyMinutes(DAY, [ev(540, 600), ev(570, 630)], [t], 570, 660)).toBe(90);
    expect(formatMinutes(90)).toBe("1 h 30 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
  });
});
