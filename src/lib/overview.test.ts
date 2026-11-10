import { describe, expect, it } from "vitest";

import { overview } from "./overview";
import type { Task } from "./types";

const NOW = new Date(2026, 9, 4, 10, 0, 0);
let n = 0;
function task(p: Partial<Task>): Task {
  n++;
  return {
    id: `/l/${n}.ics`, uid: `u${n}`, listId: "/l/", summary: `Task ${n}`, description: "", status: "needs-action",
    completed: false, completedAt: null, priority: 0, due: null, start: null, categories: [], parentUid: null, rrule: null,
    created: null, modified: null, sortOrder: null, reminders: [], planned: null, plannedMinutes: null, snoozedUntil: null,
    pending: false, ...p,
  };
}
const done = (d: Date) => task({ status: "completed", completed: true, completedAt: d.toISOString() });

describe("overview", () => {
  it("counts what matters", () => {
    const o = overview(
      [
        task({ due: "2026-10-01" }),
        task({ due: "2026-10-04" }),
        task({ due: "2026-10-08" }),
        done(new Date(2026, 9, 4, 9)),
        done(new Date(2026, 9, 3, 9)),
        done(new Date(2026, 9, 1, 9)),
      ],
      [{ id: "/l/", name: "Inbox", color: null, order: null, readOnly: false }],
      NOW,
    );
    expect(o).toMatchObject({ open: 3, overdue: 1, dueToday: 1, dueThisWeek: 2, completedToday: 1, completedThisWeek: 3, streak: 2 });
    expect(o.perDay).toHaveLength(14);
    expect(o.perDay[13].count).toBe(1);
    expect(o.byList[0].count).toBe(3);
  });
});
