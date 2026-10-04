import { startOfDay } from "date-fns";

import { formatDayHeading, isDueToday, isOverdue, parseDue } from "./dates";
import { listIdOf, type ViewId } from "./store";
import type { Task } from "./types";

export interface Row {
  task: Task;
  depth: number;
  /** Number of direct subtasks (and how many are done) for the progress hint. */
  childCount: number;
  childDone: number;
  hasVisibleChildren: boolean;
}

export interface Section {
  id: string;
  title: string | null;
  tone?: "danger" | "muted";
  rows: Row[];
}

export interface ViewOptions {
  search: string;
  showCompleted: boolean;
  collapsed: Record<string, boolean>;
  now?: Date;
}

const dueKey = (t: Task) => {
  const d = parseDue(t.due);
  return d ? d.date.getTime() : Number.POSITIVE_INFINITY;
};
const prioKey = (t: Task) => (t.priority === 0 ? 10 : t.priority);

export function compareOpen(a: Task, b: Task): number {
  return (
    dueKey(a) - dueKey(b) ||
    prioKey(a) - prioKey(b) ||
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    (a.created ?? "").localeCompare(b.created ?? "") ||
    a.summary.localeCompare(b.summary)
  );
}

export function compareDone(a: Task, b: Task): number {
  return (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || a.summary.localeCompare(b.summary);
}

function matches(t: Task, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = `${t.summary}\n${t.description}\n${t.categories.map((c) => "#" + c).join(" ")}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

export function searchTerms(search: string): string[] {
  return search.toLowerCase().split(/\s+/).filter(Boolean);
}

function inView(view: ViewId, t: Task, now: Date): boolean {
  const listId = listIdOf(view);
  if (listId) return t.listId === listId;
  switch (view) {
    case "today": {
      const due = parseDue(t.due);
      if (t.completed) return !!t.completedAt && startOfDay(new Date(t.completedAt)).getTime() === startOfDay(now).getTime();
      return isOverdue(due, now) || isDueToday(due, now);
    }
    case "upcoming":
      return !!t.due;
    case "important":
      return t.priority >= 1 && t.priority <= 4;
    default:
      return true;
  }
}

/** Builds parent → children rows (depth-first) for list views. */
function tree(tasks: Task[], all: Task[], opts: ViewOptions, sort: (a: Task, b: Task) => number): Row[] {
  const visible = new Set(tasks.map((t) => t.id));
  const byParent = new Map<string, Task[]>();
  const allByParent = new Map<string, Task[]>();
  for (const t of all) {
    if (!t.parentUid) continue;
    const key = `${t.listId}\u0000${t.parentUid}`;
    allByParent.set(key, [...(allByParent.get(key) ?? []), t]);
    if (visible.has(t.id)) byParent.set(key, [...(byParent.get(key) ?? []), t]);
  }
  const uids = new Set(tasks.map((t) => `${t.listId}\u0000${t.uid}`));
  const roots = tasks.filter((t) => !t.parentUid || !uids.has(`${t.listId}\u0000${t.parentUid}`));
  const rows: Row[] = [];
  const seen = new Set<string>();
  const walk = (t: Task, depth: number) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    const key = `${t.listId}\u0000${t.uid}`;
    const kids = [...(byParent.get(key) ?? [])].sort((a, b) => Number(a.completed) - Number(b.completed) || sort(a, b));
    const allKids = allByParent.get(key) ?? [];
    rows.push({
      task: t,
      depth,
      childCount: allKids.length,
      childDone: allKids.filter((k) => k.completed).length,
      hasVisibleChildren: kids.length > 0,
    });
    if (!opts.collapsed[t.uid]) kids.forEach((k) => walk(k, depth + 1));
  };
  roots.sort(sort).forEach((t) => walk(t, 0));
  return rows;
}

function flat(tasks: Task[], all: Task[]): Row[] {
  return tasks.map((task) => {
    const kids = all.filter((k) => k.parentUid === task.uid && k.listId === task.listId);
    return {
      task,
      depth: 0,
      childCount: kids.length,
      childDone: kids.filter((k) => k.completed).length,
      hasVisibleChildren: false,
    };
  });
}

export function buildSections(view: ViewId, all: Task[], opts: ViewOptions): Section[] {
  const now = opts.now ?? new Date();
  const terms = searchTerms(opts.search);
  const inThisView = all.filter((t) => inView(view, t, now) && matches(t, terms));
  const open = inThisView.filter((t) => !t.completed);
  const done = opts.showCompleted ? inThisView.filter((t) => t.completed) : [];
  const sections: Section[] = [];

  if (view === "today") {
    const overdue = open.filter((t) => isOverdue(parseDue(t.due), now) && !isDueToday(parseDue(t.due), now));
    const today = open.filter((t) => !overdue.includes(t));
    if (overdue.length) sections.push({ id: "overdue", title: "Overdue", tone: "danger", rows: flat(overdue.sort(compareOpen), all) });
    sections.push({ id: "today", title: overdue.length ? "Today" : null, rows: flat(today.sort(compareOpen), all) });
  } else if (view === "upcoming") {
    const groups = new Map<string, Task[]>();
    const overdue: Task[] = [];
    for (const t of open.sort(compareOpen)) {
      const due = parseDue(t.due)!;
      if (isOverdue(due, now) && !isDueToday(due, now)) {
        overdue.push(t);
        continue;
      }
      const key = startOfDay(due.date).toISOString();
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    if (overdue.length) sections.push({ id: "overdue", title: "Overdue", tone: "danger", rows: flat(overdue, all) });
    for (const [key, tasks] of groups) {
      sections.push({ id: key, title: formatDayHeading(new Date(key), now), rows: flat(tasks, all) });
    }
    if (!sections.length) sections.push({ id: "empty", title: null, rows: [] });
  } else if (listIdOf(view)) {
    const visible = opts.showCompleted ? inThisView : open;
    // Completed subtasks of open parents stay nested under their parent.
    const parentsOpen = new Set(open.map((t) => `${t.listId}\u0000${t.uid}`));
    const nestedDone = done.filter((t) => t.parentUid && parentsOpen.has(`${t.listId}\u0000${t.parentUid}`));
    const openRows = tree([...open, ...nestedDone], all, opts, compareOpen);
    sections.push({ id: "open", title: null, rows: openRows });
    const shown = new Set(openRows.map((r) => r.task.id));
    const rest = visible.filter((t) => t.completed && !shown.has(t.id));
    if (rest.length) sections.push({ id: "done", title: "Completed", tone: "muted", rows: tree(rest, all, opts, compareDone) });
    return sections;
  } else {
    sections.push({ id: "open", title: null, rows: flat(open.sort(compareOpen), all) });
  }

  if (done.length) sections.push({ id: "done", title: "Completed", tone: "muted", rows: flat(done.sort(compareDone), all) });
  return sections;
}

export function countOpen(view: ViewId, all: Task[], now = new Date()): number {
  let n = 0;
  for (const t of all) if (!t.completed && inView(view, t, now)) n++;
  return n;
}
