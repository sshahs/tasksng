import { addDays, startOfDay } from "date-fns";

import { isOverdue, parseDue } from "./dates";
import type { Task } from "./types";

/**
 * Search and saved-search filters. Words match the title, notes and tags;
 * filters narrow things down, and `-` in front of anything excludes it:
 *
 *   `#home`  `!1` / `!high`  `list:Work` / `list:"Big project"`
 *   `due:today|tomorrow|overdue|week|none|any|2026-10-31`
 *   `is:open|done|progress|cancelled|repeating|reminder|subtask|later`
 */

export interface QueryContext {
  /** List id → list name. */
  listNames: Map<string, string>;
  now: Date;
}

interface Clause {
  neg: boolean;
  test: (t: Task, ctx: QueryContext) => boolean;
}

export interface Query {
  clauses: Clause[];
  /** The query asks for finished tasks, so they are not hidden. */
  wantsDone: boolean;
  /** The query asks for tasks that start later. */
  wantsLater: boolean;
  /** Values new tasks get when added while this query is shown. */
  defaults: { tags: string[]; priority: number | null; due: "today" | "tomorrow" | null; list: string | null };
  empty: boolean;
}

export const FILTER_HELP: [string, string][] = [
  ["#home", "tagged home"],
  ["!1  !2  !3", "high, medium, low priority"],
  ["list:Work", "in a list"],
  ["due:today", "today, tomorrow, overdue, week, none"],
  ["is:progress", "open, done, progress, cancelled, repeating, reminder"],
  ["-#work", "minus excludes"],
];

const level = (p: number) => (p === 0 ? 0 : p <= 4 ? 1 : p === 5 ? 2 : 3);

function priorityLevel(v: string): number | null {
  switch (v.toLowerCase()) {
    case "1":
    case "high":
    case "!":
      return 1;
    case "2":
    case "med":
    case "medium":
      return 2;
    case "3":
    case "low":
      return 3;
    case "0":
    case "none":
      return 0;
    default:
      return null;
  }
}

export function startsLater(t: Task, now: Date): boolean {
  const start = parseDue(t.start);
  return !!start && startOfDay(start.date).getTime() > startOfDay(now).getTime();
}

function dueTest(v: string): Clause["test"] | null {
  const day = (t: Task) => {
    const d = parseDue(t.due);
    return d ? startOfDay(d.date).getTime() : null;
  };
  switch (v.toLowerCase()) {
    case "today":
      return (t, c) => day(t) === startOfDay(c.now).getTime();
    case "tomorrow":
      return (t, c) => day(t) === startOfDay(addDays(c.now, 1)).getTime();
    case "overdue":
      return (t, c) => !t.completed && isOverdue(parseDue(t.due), c.now);
    case "week":
      return (t, c) => {
        const d = day(t);
        return d !== null && d >= startOfDay(c.now).getTime() && d <= startOfDay(addDays(c.now, 6)).getTime();
      };
    case "none":
      return (t) => !t.due;
    case "any":
      return (t) => !!t.due;
    default:
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m, d] = v.split("-").map(Number);
        const target = new Date(y, m - 1, d).getTime();
        return (t) => day(t) === target;
      }
      return null;
  }
}

function isTest(v: string): Clause["test"] | null {
  switch (v.toLowerCase()) {
    case "open":
    case "todo":
      return (t) => !t.completed;
    case "done":
    case "completed":
      return (t) => t.status === "completed";
    case "progress":
    case "inprogress":
    case "in-progress":
    case "started":
      return (t) => t.status === "in-process";
    case "cancelled":
    case "canceled":
      return (t) => t.status === "cancelled";
    case "repeating":
    case "recurring":
      return (t) => !!t.rrule;
    case "reminder":
    case "reminders":
      return (t) => t.reminders.length > 0;
    case "subtask":
      return (t) => !!t.parentUid;
    case "important":
      return (t) => level(t.priority) === 1;
    case "later":
      return (t, c) => startsLater(t, c.now);
    default:
      return null;
  }
}

const TOKEN = /(-)?(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;

export function parseQuery(input: string): Query {
  const clauses: Clause[] = [];
  const q: Query = {
    clauses,
    wantsDone: false,
    wantsLater: false,
    defaults: { tags: [], priority: null, due: null, list: null },
    empty: true,
  };
  for (const m of input.matchAll(TOKEN)) {
    const neg = !!m[1];
    const key = m[2]?.toLowerCase();
    const value = (m[3] ?? m[4] ?? "").trim();
    if (!value) continue;
    let test: Clause["test"] | null = null;
    if (key === "tag" || (!key && value.startsWith("#") && value.length > 1)) {
      const tag = (key ? value : value.slice(1)).toLowerCase();
      test = (t) => t.categories.some((c) => c.toLowerCase() === tag);
      if (!neg) q.defaults.tags.push(key ? value : value.slice(1));
    } else if (!key && /^!(!!?|[0-3]|high|med|medium|low|none)?$/i.test(value)) {
      const raw = value.slice(1);
      const lvl = raw === "!!" ? 1 : raw === "!" ? 2 : raw === "" ? 3 : priorityLevel(raw);
      if (lvl !== null) {
        test = (t) => level(t.priority) === lvl;
        if (!neg && lvl > 0) q.defaults.priority = lvl === 1 ? 1 : lvl === 2 ? 5 : 9;
      }
    } else if (key === "priority" || key === "p") {
      const lvl = priorityLevel(value);
      if (lvl !== null) test = (t) => level(t.priority) === lvl;
    } else if (key === "list" || key === "in") {
      const name = value.toLowerCase();
      test = (t, c) => (c.listNames.get(t.listId) ?? "").toLowerCase().includes(name);
      if (!neg) q.defaults.list = value;
    } else if (key === "due") {
      test = dueTest(value);
      if (test && !neg && (value === "today" || value === "tomorrow")) q.defaults.due = value;
    } else if (key === "is") {
      test = isTest(value);
      const v = value.toLowerCase();
      if (test && !neg && ["done", "completed", "cancelled", "canceled"].includes(v)) q.wantsDone = true;
      if (test && !neg && v === "later") q.wantsLater = true;
    }
    if (!test) {
      // Plain words (and unknown filters) match the text.
      const word = (key ? `${m[2]}:${value}` : value).toLowerCase();
      test = (t) => `${t.summary}\n${t.description}\n${t.categories.map((c) => "#" + c).join(" ")}`.toLowerCase().includes(word);
    }
    clauses.push({ neg, test });
  }
  q.empty = clauses.length === 0;
  return q;
}

export function matchesQuery(t: Task, q: Query, ctx: QueryContext): boolean {
  return q.clauses.every((c) => c.test(t, ctx) !== c.neg);
}
