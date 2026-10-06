import { describe, expect, it } from "vitest";

import { comparator, manualKey, ORDER_STEP, planReorder } from "./sort";
import type { Task } from "./types";

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

describe("sorting", () => {
  it("manual order falls back to creation time (Apple's convention)", () => {
    const a = task({ created: "2026-10-01T00:00:00Z" });
    const b = task({ sortOrder: 5 });
    expect(manualKey(a)).toBe(Date.UTC(2026, 9, 1) / 1000 - 978_307_200);
    expect([a, b].sort(comparator("manual"))).toEqual([b, a]);
  });

  it("other modes", () => {
    const x = task({ summary: "b", priority: 9, created: "2026-10-02T00:00:00Z" });
    const y = task({ summary: "a", priority: 1, created: "2026-10-01T00:00:00Z" });
    expect([x, y].sort(comparator("priority"))[0]).toBe(y);
    expect([x, y].sort(comparator("title"))[0]).toBe(y);
    expect([y, x].sort(comparator("created"))[0]).toBe(x);
  });
});

describe("planReorder", () => {
  const a = task({ sortOrder: 1000 });
  const b = task({ sortOrder: 2000 });
  const c = task({ sortOrder: 3000 });

  it("writes only the moved task when there is room", () => {
    expect(planReorder([a, b, c], c, 1, null)).toEqual([{ id: c.id, patch: { sortOrder: 1500 } }]);
    expect(planReorder([a, b, c], a, 3, null)).toEqual([{ id: a.id, patch: { sortOrder: 3000 + ORDER_STEP } }]);
    expect(planReorder([a, b, c], c, 0, null)).toEqual([{ id: c.id, patch: { sortOrder: 1000 - ORDER_STEP } }]);
  });

  it("renumbers when neighbours are adjacent or out of order", () => {
    const x = task({ sortOrder: 1 });
    const y = task({ sortOrder: 2 });
    const z = task({ sortOrder: 9 });
    const plan = planReorder([x, y, z], z, 1, null);
    expect(plan.map((u) => u.patch.sortOrder)).toEqual([ORDER_STEP, 2 * ORDER_STEP, 3 * ORDER_STEP]);
    expect(plan.map((u) => u.id)).toEqual([x.id, z.id, y.id]);
    // Shown sorted by due date, keys not increasing: renumber in shown order.
    const shown = [c, a, b];
    const out = planReorder(shown, b, 0, null);
    expect(out.find((u) => u.id === b.id)!.patch.sortOrder).toBeLessThan(out.find((u) => u.id === c.id)!.patch.sortOrder!);
  });

  it("changes the parent when nesting", () => {
    const p = task({});
    expect(planReorder([], a, 0, p.uid)).toEqual([{ id: a.id, patch: { parentUid: p.uid } }]);
    expect(planReorder([b], a, 1, p.uid)).toEqual([{ id: a.id, patch: { sortOrder: 2000 + ORDER_STEP, parentUid: p.uid } }]);
  });
});
