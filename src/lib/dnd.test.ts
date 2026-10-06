import { describe, expect, it } from "vitest";

import { planDrop, planKeyboardMove } from "./dnd";
import type { Task } from "./types";
import { buildSections } from "./views";

let n = 0;
const task = (p: Partial<Task>): Task => ({
  id: `/l/${++n}.ics`,
  uid: `u${n}`,
  listId: "/l/",
  summary: `t${n}`,
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
  pending: false,
  ...p,
});

const a = task({ summary: "a", sortOrder: 1000 });
const b = task({ summary: "b", sortOrder: 2000 });
const c = task({ summary: "c", sortOrder: 3000 });
const b1 = task({ summary: "b1", sortOrder: 10, parentUid: b.uid });
const all = [a, b, c, b1];
const rows = buildSections("list:/l/", all, { search: "", showCompleted: false, collapsed: {}, sort: "manual" })[0].rows;

describe("drag and drop", () => {
  it("reorders among siblings", () => {
    expect(rows.map((r) => r.task.summary)).toEqual(["a", "b", "b1", "c"]);
    const plan = planDrop(c, a, "after", rows, all, {})!;
    expect(plan.updates).toEqual([{ id: c.id, patch: { sortOrder: 1500 } }]);
    expect(plan.reordered).toBe(true);
  });

  it("nests and un-nests", () => {
    const into = planDrop(c, a, "inside", rows, all, {})!;
    expect(into.updates).toEqual([{ id: c.id, patch: { parentUid: a.uid } }]);
    expect(into.expand).toBe(a.uid);
    // Dropping below an expanded parent makes it the first child.
    const first = planDrop(c, b, "after", rows, all, {})!;
    expect(first.updates[0].patch.parentUid).toBe(b.uid);
    expect(first.updates[0].patch.sortOrder).toBeLessThan(10);
    // Dropping a subtask between top-level tasks makes it top-level.
    const out = planDrop(b1, a, "before", rows, all, {})!;
    expect(out.updates[0].patch.parentUid).toBeNull();
  });

  it("refuses impossible drops", () => {
    expect(planDrop(b, b1, "inside", rows, all, {})).toBeNull();
    expect(planDrop(a, a, "after", rows, all, {})).toBeNull();
  });

  it("moves with the keyboard", () => {
    expect(planKeyboardMove(c, "up", rows, all)!.updates).toEqual([{ id: c.id, patch: { sortOrder: 1500 } }]);
    expect(planKeyboardMove(a, "up", rows, all)).toBeNull();
    expect(planKeyboardMove(c, "in", rows, all)!.updates[0].patch.parentUid).toBe(b.uid);
    expect(planKeyboardMove(b1, "out", rows, all)!.updates[0].patch).toMatchObject({ parentUid: null, sortOrder: 2500 });
  });
});
