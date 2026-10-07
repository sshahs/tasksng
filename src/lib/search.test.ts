import { describe, expect, it } from "vitest";

import { matchesQuery, parseQuery } from "./search";
import type { Task } from "./types";

const NOW = new Date(2026, 9, 4, 10, 0, 0);
const ctx = { listNames: new Map([["/w/", "Work"], ["/h/", "Home stuff"]]), now: NOW };
let n = 0;
const task = (p: Partial<Task>): Task => ({
  id: `/w/${++n}.ics`,
  uid: `u${n}`,
  listId: "/w/",
  summary: "",
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
});

const match = (q: string, t: Task) => matchesQuery(t, parseQuery(q), ctx);

describe("parseQuery", () => {
  it("matches words in title, notes and tags", () => {
    const t = task({ summary: "Buy milk", description: "semi-skimmed", categories: ["Shop"] });
    expect(match("milk", t)).toBe(true);
    expect(match("buy skimmed", t)).toBe(true);
    expect(match("bread", t)).toBe(false);
    expect(match('"buy milk"', t)).toBe(true);
  });

  it("understands filters and negation", () => {
    const t = task({ summary: "Report", categories: ["work"], priority: 1, due: "2026-10-04", listId: "/h/" });
    expect(match("#work", t)).toBe(true);
    expect(match("#WORK !1", t)).toBe(true);
    expect(match("!high", t)).toBe(true);
    expect(match("!2", t)).toBe(false);
    expect(match("-#work", t)).toBe(false);
    expect(match("due:today", t)).toBe(true);
    expect(match("due:week", t)).toBe(true);
    expect(match("due:tomorrow", t)).toBe(false);
    expect(match("due:none", t)).toBe(false);
    expect(match('list:"home st"', t)).toBe(true);
    expect(match("list:work", t)).toBe(false);
    expect(match("is:open -is:repeating", t)).toBe(true);
    expect(match("due:overdue", task({ due: "2026-10-01" }))).toBe(true);
    expect(match("is:progress", task({ status: "in-process" }))).toBe(true);
    expect(match("is:reminder", task({ reminders: [{ offset: 0, related: "due" }] }))).toBe(true);
    expect(match("is:later", task({ start: "2026-10-09" }))).toBe(true);
  });

  it("treats unknown filters as text", () => {
    expect(match("http://x", task({ summary: "see http://x" }))).toBe(true);
    expect(match("foo:bar", task({ summary: "nothing" }))).toBe(false);
  });

  it("collects defaults for new tasks and what to show", () => {
    const q = parseQuery("#errands !2 due:today list:Home is:done");
    expect(q.defaults).toEqual({ tags: ["errands"], priority: 5, due: "today", list: "Home" });
    expect(q.wantsDone).toBe(true);
    expect(parseQuery("  ").empty).toBe(true);
  });
});
