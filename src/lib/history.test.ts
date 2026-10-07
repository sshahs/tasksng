import { describe, expect, it } from "vitest";

import { changesIn, restorePatch, versionTime } from "./history";
import type { Task, TaskVersion } from "./types";

function task(p: Partial<Task>): Task {
  return {
    id: "/l/a.ics",
    uid: "a",
    listId: "/l/",
    summary: "Task",
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

describe("history", () => {
  const versions: TaskVersion[] = [
    { at: "2026-10-07T10:00:00Z", source: "here", task: task({ summary: "B", due: "2026-10-09", priority: 1 }) },
    { at: "2026-10-06T10:00:00Z", source: "elsewhere", task: task({ summary: "B", due: "2026-10-08" }) },
    { at: "2026-10-05T10:00:00Z", source: "created", task: task({ summary: "A", modified: "x", sortOrder: 4 }) },
  ];

  it("lists what each version changed", () => {
    expect(changesIn(versions, 0).map((f) => f.key)).toEqual(["due", "priority"]);
    expect(changesIn(versions, 1).map((f) => f.key)).toEqual(["summary", "due"]);
    expect(changesIn(versions, 2)).toEqual([]);
  });

  it("restores only the fields that differ", () => {
    const current = versions[0].task;
    expect(restorePatch(current, versions[2].task)).toEqual({ summary: "A", due: null, priority: 0 });
    expect(restorePatch(current, { ...current, modified: "later" })).toBeNull();
  });

  it("says when", () => {
    const now = new Date(2026, 9, 7, 12, 0);
    expect(versionTime(new Date(2026, 9, 7, 9, 5).toISOString(), now)).toBe("Today 09:05");
    expect(versionTime(new Date(2026, 9, 6, 18, 30).toISOString(), now)).toBe("Yesterday 18:30");
    expect(versionTime(new Date(2026, 9, 3, 8, 0).toISOString(), now)).toBe("Sat 3 Oct 08:00");
    expect(versionTime(new Date(2025, 0, 3, 8, 0).toISOString(), now)).toBe("3 Jan 2025 08:00");
  });
});
