import { describe, expect, it } from "vitest";

import { widgetItems } from "./android";
import type { Task, TaskList } from "./types";

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
    pending: false,
    ...p,
  };
}

describe("widget feed", () => {
  it("sends the open tasks of the coming week with their list colour", () => {
    const now = new Date(2026, 9, 6, 10);
    const lists: TaskList[] = [{ id: "/l/", name: "Personal", color: "#3B82F6", order: null, readOnly: false }];
    const items = widgetItems(
      [
        task({ summary: "late", due: "2026-09-30" }),
        task({ summary: "today", due: "2026-10-06T14:00:00Z", priority: 1 }),
        task({ summary: "next week", due: "2026-10-13" }),
        task({ summary: "too far", due: "2026-10-20" }),
        task({ summary: "no date" }),
        task({ summary: "done", due: "2026-10-06", completed: true, status: "completed" }),
        task({ summary: "planned", planned: "2026-10-07T09:00:00Z" }),
      ],
      lists,
      now,
    );
    expect(items.map((i) => i.title)).toEqual(["late", "today", "next week", "planned"]);
    expect(items[1]).toMatchObject({ due: "2026-10-06T14:00:00Z", priority: 1, color: "#3B82F6" });
  });
});
