import { describe, expect, it } from "vitest";

import { defaultPicks, differingFields, resolutionFor } from "./conflicts";
import type { ConflictView, Task } from "./types";

function task(p: Partial<Task>): Task {
  return {
    id: "/l/1.ics",
    uid: "u1",
    listId: "/l/",
    summary: "Base",
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
    modified: "2026-10-06T10:00:00Z",
    sortOrder: null,
    reminders: [],
    planned: null,
    plannedMinutes: null,
    pending: false,
    ...p,
  };
}

const conflict = (mine: Partial<Task> | null, theirs: Partial<Task> | null): ConflictView => ({
  id: "/l/1.ics",
  listId: "/l/",
  mine: mine && task(mine),
  theirs: theirs && task(theirs),
  at: "2026-10-06T10:05:00Z",
});

describe("conflicts", () => {
  it("lists only the fields that differ", () => {
    const c = conflict({ summary: "Mine", priority: 1 }, { summary: "Theirs", priority: 2, description: " " });
    expect(differingFields(c.mine!, c.theirs!).map((f) => f.key)).toEqual(["summary"]);
  });

  it("starts from the newer version", () => {
    const c = conflict({ summary: "Mine", modified: "2026-10-06T11:00:00Z" }, { summary: "Theirs", due: "2026-10-07" });
    expect(defaultPicks(c)).toEqual({ summary: "mine", due: "mine" });
    const older = conflict({ summary: "Mine", modified: "2026-10-06T09:00:00Z" }, { summary: "Theirs" });
    expect(defaultPicks(older)).toEqual({ summary: "theirs" });
  });

  it("sends one side whole, or theirs with the fields picked from mine", () => {
    const c = conflict({ summary: "Mine", due: "2026-10-08" }, { summary: "Theirs", due: "2026-10-07", categories: ["x"] });
    expect(resolutionFor(c, { summary: "mine", due: "mine", categories: "mine" })).toEqual({ keep: "mine" });
    expect(resolutionFor(c, {})).toEqual({ keep: "theirs" });
    expect(resolutionFor(c, { summary: "mine", due: "theirs", categories: "theirs" })).toEqual({
      keep: "merge",
      patch: { summary: "Mine" },
    });
  });

  it("handles a deletion on either side", () => {
    expect(resolutionFor(conflict(null, { summary: "Theirs" }), { all: "mine" })).toEqual({ keep: "mine" });
    expect(resolutionFor(conflict({ summary: "Mine" }, null), { all: "theirs" })).toEqual({ keep: "theirs" });
  });
});
