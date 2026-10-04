import { describe, expect, it } from "vitest";

import type { Task } from "./types";
import { buildSections, countOpen } from "./views";

const NOW = new Date(2026, 9, 4, 10, 0, 0);
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
    pending: false,
    ...p,
  };
}

const opts = { search: "", showCompleted: false, collapsed: {}, now: NOW };

describe("buildSections", () => {
  it("today shows overdue and due-today tasks", () => {
    const tasks = [
      task({ summary: "late", due: "2026-10-01" }),
      task({ summary: "now", due: "2026-10-04" }),
      task({ summary: "later", due: "2026-10-05" }),
      task({ summary: "none" }),
    ];
    const s = buildSections("today", tasks, opts);
    expect(s.map((x) => x.title)).toEqual(["Overdue", "Today"]);
    expect(s[0].rows.map((r) => r.task.summary)).toEqual(["late"]);
    expect(s[1].rows.map((r) => r.task.summary)).toEqual(["now"]);
    expect(countOpen("today", tasks, NOW)).toBe(2);
  });

  it("nests subtasks in list views and sorts by due/priority", () => {
    const parent = task({ summary: "parent", listId: "/a/" });
    const tasks = [
      task({ summary: "b", listId: "/a/", priority: 1 }),
      parent,
      task({ summary: "child", listId: "/a/", parentUid: parent.uid }),
      task({ summary: "a", listId: "/a/", due: "2026-10-10" }),
      task({ summary: "other list", listId: "/b/" }),
    ];
    const rows = buildSections("list:/a/", tasks, opts)[0].rows;
    expect(rows.map((r) => [r.task.summary, r.depth])).toEqual([
      ["a", 0],
      ["b", 0],
      ["parent", 0],
      ["child", 1],
    ]);
    expect(rows[2].childCount).toBe(1);
  });

  it("hides completed unless asked, keeping done subtasks under open parents", () => {
    const parent = task({ summary: "p", listId: "/c/" });
    const tasks = [
      parent,
      task({ summary: "done child", listId: "/c/", parentUid: parent.uid, completed: true, status: "completed" }),
      task({ summary: "done", listId: "/c/", completed: true, status: "completed", completedAt: "2026-10-03T10:00:00Z" }),
    ];
    expect(buildSections("list:/c/", tasks, opts).flatMap((s) => s.rows).length).toBe(1);
    const s = buildSections("list:/c/", tasks, { ...opts, showCompleted: true });
    expect(s[0].rows.map((r) => r.task.summary)).toEqual(["p", "done child"]);
    expect(s[1].title).toBe("Completed");
    expect(s[1].rows.map((r) => r.task.summary)).toEqual(["done"]);
  });

  it("filters by search terms including tags", () => {
    const tasks = [task({ summary: "Buy milk", categories: ["shop"] }), task({ summary: "Call mom" })];
    const s = buildSections("all", tasks, { ...opts, search: "#shop" });
    expect(s[0].rows.map((r) => r.task.summary)).toEqual(["Buy milk"]);
  });

  it("groups upcoming by day", () => {
    const tasks = [task({ due: "2026-10-05" }), task({ due: "2026-10-05" }), task({ due: "2026-10-20" })];
    const s = buildSections("upcoming", tasks, opts);
    expect(s.map((x) => x.title)).toEqual(["Tomorrow", "Tuesday, 20 October"]);
  });
});
