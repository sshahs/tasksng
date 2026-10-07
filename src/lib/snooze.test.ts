import { describe, expect, it } from "vitest";

import { isSnoozed, nextWake, snoozeLabel, snoozePresets } from "./snooze";
import type { Task } from "./types";
import { buildSections, countOpen } from "./views";

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

const iso = (d: Date) => d.toISOString();

describe("snooze", () => {
  it("offers the choices that fit the time of day", () => {
    const tuesdayMorning = new Date(2026, 9, 6, 9, 5);
    expect(snoozePresets(tuesdayMorning).map((p) => [p.id, p.hint])).toEqual([
      ["later", "12:15"],
      ["evening", "19:00"],
      ["tomorrow", "Wed 09:00"],
      ["weekend", "Sat 09:00"],
      ["week", "Mon 12 Oct"],
    ]);
    const fridayNight = new Date(2026, 9, 9, 20, 30);
    expect(snoozePresets(fridayNight).map((p) => p.id)).toEqual(["tomorrow", "week"]);
  });

  it("hides a task until it comes back", () => {
    const now = new Date(2026, 9, 6, 9, 0);
    const later = new Date(2026, 9, 6, 18, 0);
    const t = task({ summary: "snoozed", due: "2026-10-06", snoozedUntil: iso(later) });
    const other = task({ summary: "today", due: "2026-10-06" });
    expect(isSnoozed(t, now)).toBe(true);
    expect(nextWake([t, other], now)?.getTime()).toBe(later.getTime());
    const opts = { search: "", showCompleted: false, collapsed: {}, now };
    expect(buildSections("today", [t, other], opts).flatMap((s) => s.rows.map((r) => r.task.summary))).toEqual(["today"]);
    expect(countOpen("today", [t, other], now)).toBe(1);
    // In a list it waits in its own section.
    const list = buildSections("list:/l/", [t, other], opts);
    expect(list.find((s) => s.id === "snoozed")?.rows.map((r) => r.task.summary)).toEqual(["snoozed"]);
    // And it's back once the time has come.
    const after = new Date(2026, 9, 6, 18, 1);
    expect(buildSections("today", [t, other], { ...opts, now: after }).flatMap((s) => s.rows).length).toBe(2);
    expect(snoozeLabel(iso(later), now)).toBe("until 18:00");
  });
});
