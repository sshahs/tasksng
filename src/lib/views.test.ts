import { describe, expect, it } from "vitest";

import type { Task } from "./types";
import { buildSections, countOpen, tagCounts } from "./views";

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
    reminders: [],
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

  it("keeps tasks that start later out of the way", () => {
    const tasks = [
      task({ summary: "starts today", start: "2026-10-04", listId: "/s/" }),
      task({ summary: "starts friday", start: "2026-10-09", listId: "/s/" }),
      task({ summary: "plain", listId: "/s/" }),
    ];
    expect(buildSections("today", tasks, opts)[0].rows.map((r) => r.task.summary)).toEqual(["starts today"]);
    const allView = buildSections("all", tasks, opts);
    expect(allView[0].rows.map((r) => r.task.summary)).not.toContain("starts friday");
    expect(allView[1]).toMatchObject({ title: "Starts later" });
    expect(countOpen("all", tasks, NOW)).toBe(2);
    const list = buildSections("list:/s/", tasks, opts);
    expect(list.map((s) => s.title)).toEqual([null, "Starts later"]);
    expect(list[1].rows.map((r) => r.task.summary)).toEqual(["starts friday"]);
    expect(countOpen("list:/s/", tasks, NOW)).toBe(2);
    // Searching finds them anyway, and Upcoming lists them on their start day.
    expect(buildSections("list:/s/", tasks, { ...opts, search: "friday" })[0].rows.length).toBe(1);
    expect(buildSections("upcoming", tasks, opts).map((s) => s.title)).toEqual(["Friday"]);
  });

  it("shows tag views and saved searches", () => {
    const tasks = [
      task({ summary: "milk", categories: ["Shop"], listId: "/a/" }),
      task({ summary: "report", categories: ["work"], priority: 1, listId: "/b/" }),
      task({ summary: "old", categories: ["work"], completed: true, status: "completed" }),
    ];
    expect(buildSections("tag:shop", tasks, opts)[0].rows.map((r) => r.task.summary)).toEqual(["milk"]);
    const saved = [{ id: "s1", name: "Urgent work", query: "#work !1" }, { id: "s2", name: "Done", query: "#work is:done" }];
    const so = { ...opts, savedSearches: saved };
    expect(buildSections("search:s1", tasks, so)[0].rows.map((r) => r.task.summary)).toEqual(["report"]);
    expect(buildSections("search:s2", tasks, so).flatMap((s) => s.rows).map((r) => r.task.summary)).toEqual(["old"]);
    expect(countOpen("tag:work", tasks, NOW)).toBe(1);
    expect(tagCounts(tasks)).toEqual([
      { tag: "Shop", count: 1 },
      { tag: "work", count: 1 },
    ]);
  });

  it("sorts by the chosen mode", () => {
    const tasks = [
      task({ summary: "b", listId: "/m/", sortOrder: 2 }),
      task({ summary: "a", listId: "/m/", sortOrder: 3 }),
      task({ summary: "c", listId: "/m/", sortOrder: 1 }),
    ];
    const names = (sort: "manual" | "title") => buildSections("list:/m/", tasks, { ...opts, sort })[0].rows.map((r) => r.task.summary);
    expect(names("manual")).toEqual(["c", "b", "a"]);
    expect(names("title")).toEqual(["a", "b", "c"]);
  });

  it("groups upcoming by day", () => {
    const tasks = [task({ due: "2026-10-05" }), task({ due: "2026-10-05" }), task({ due: "2026-10-20" })];
    const s = buildSections("upcoming", tasks, opts);
    expect(s.map((x) => x.title)).toEqual(["Tomorrow", "Tuesday, 20 October"]);
  });
});
