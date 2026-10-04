import { startOfDay } from "date-fns";

import { formatDayHeading, isDueToday, isOverdue, parseDue } from "./dates";
import { matchesQuery, parseQuery, startsLater, type Query, type QueryContext } from "./search";
import { comparator, compareDone, compareOpen, type SortMode } from "./sort";
import type { Task, TaskList } from "./types";

export { compareDone, compareOpen };

export type SmartView = "today" | "upcoming" | "important" | "all";
export type ViewId = SmartView | `list:${string}` | `tag:${string}` | `search:${string}`;

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
}

export function listIdOf(view: ViewId): string | null {
  return view.startsWith("list:") ? view.slice(5) : null;
}
export function tagOf(view: ViewId): string | null {
  return view.startsWith("tag:") ? view.slice(4) : null;
}
export function searchIdOf(view: ViewId): string | null {
  return view.startsWith("search:") ? view.slice(7) : null;
}

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
  sort?: SortMode;
  lists?: TaskList[];
  savedSearches?: SavedSearch[];
  now?: Date;
}

const sameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime();

function startsToday(t: Task, now: Date): boolean {
  const start = parseDue(t.start);
  return !!start && sameDay(start.date, now);
}

/** The saved query behind a view, if it is a tag or saved-search view. */
function viewQuery(view: ViewId, saved: SavedSearch[] | undefined): Query | null {
  const tag = tagOf(view);
  if (tag !== null) return parseQuery(`tag:"${tag.replace(/"/g, "")}"`);
  const id = searchIdOf(view);
  if (id !== null) return parseQuery(saved?.find((s) => s.id === id)?.query ?? "");
  return null;
}

function inView(view: ViewId, t: Task, now: Date, q: Query | null, ctx: QueryContext): boolean {
  const listId = listIdOf(view);
  if (listId) return t.listId === listId;
  const later = !t.completed && startsLater(t, now);
  if (q) return matchesQuery(t, q, ctx);
  switch (view) {
    case "today": {
      const due = parseDue(t.due);
      if (t.completed) return !!t.completedAt && sameDay(new Date(t.completedAt), now);
      return isOverdue(due, now) || isDueToday(due, now) || startsToday(t, now);
    }
    case "upcoming":
      return !!t.due || later;
    case "important":
      return t.priority >= 1 && t.priority <= 4 && !later;
    case "all":
      return true;
    default:
      return false;
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

function context(opts: Pick<ViewOptions, "lists">, now: Date): QueryContext {
  return { listNames: new Map((opts.lists ?? []).map((l) => [l.id, l.name])), now };
}

export function buildSections(view: ViewId, all: Task[], opts: ViewOptions): Section[] {
  const now = opts.now ?? new Date();
  const ctx = context(opts, now);
  const q = viewQuery(view, opts.savedSearches);
  const search = opts.search.trim() ? parseQuery(opts.search) : null;
  const sort = comparator(opts.sort ?? "smart");
  const inThisView = all.filter(
    (t) => inView(view, t, now, q, ctx) && (!search || matchesQuery(t, search, ctx)),
  );
  // Finished tasks are hidden unless asked for (or the saved search is about them).
  const showDone = opts.showCompleted || !!q?.wantsDone || !!search?.wantsDone;
  const open = inThisView.filter((t) => !t.completed);
  const done = showDone ? inThisView.filter((t) => t.completed) : [];
  const sections: Section[] = [];

  if (view === "today") {
    const overdue = open.filter((t) => isOverdue(parseDue(t.due), now) && !isDueToday(parseDue(t.due), now));
    const today = open.filter((t) => !overdue.includes(t));
    if (overdue.length) sections.push({ id: "overdue", title: "Overdue", tone: "danger", rows: flat(overdue.sort(sort), all) });
    sections.push({ id: "today", title: overdue.length ? "Today" : null, rows: flat(today.sort(sort), all) });
  } else if (view === "upcoming") {
    const groups = new Map<string, Task[]>();
    const overdue: Task[] = [];
    const day = (t: Task) => (parseDue(t.due) ?? parseDue(t.start))!.date;
    for (const t of open.sort((a, b) => day(a).getTime() - day(b).getTime() || sort(a, b))) {
      const due = parseDue(t.due);
      if (due && isOverdue(due, now) && !isDueToday(due, now)) {
        overdue.push(t);
        continue;
      }
      const key = startOfDay(day(t)).toISOString();
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    if (overdue.length) sections.push({ id: "overdue", title: "Overdue", tone: "danger", rows: flat(overdue, all) });
    for (const [key, tasks] of groups) {
      sections.push({ id: key, title: formatDayHeading(new Date(key), now), rows: flat(tasks.sort(sort), all) });
    }
    if (!sections.length) sections.push({ id: "empty", title: null, rows: [] });
  } else if (listIdOf(view)) {
    // Tasks that start later wait in their own section (search finds them anyway).
    const later = search ? [] : open.filter((t) => startsLater(t, now));
    const current = open.filter((t) => !later.includes(t));
    // Completed subtasks of open parents stay nested under their parent.
    const parentsOpen = new Set(current.map((t) => `${t.listId}\u0000${t.uid}`));
    const nestedDone = done.filter((t) => t.parentUid && parentsOpen.has(`${t.listId}\u0000${t.parentUid}`));
    const openRows = tree([...current, ...nestedDone], all, opts, sort);
    sections.push({ id: "open", title: null, rows: openRows });
    if (later.length) {
      const byStart = (a: Task, b: Task) =>
        (parseDue(a.start)?.date.getTime() ?? 0) - (parseDue(b.start)?.date.getTime() ?? 0) || sort(a, b);
      sections.push({ id: "later", title: "Starts later", tone: "muted", rows: tree(later, all, opts, byStart) });
    }
    const shown = new Set(openRows.map((r) => r.task.id));
    const rest = done.filter((t) => !shown.has(t.id));
    if (rest.length) sections.push({ id: "done", title: "Completed", tone: "muted", rows: tree(rest, all, opts, compareDone) });
    return sections;
  } else {
    // All tasks, tags and saved searches: tasks that start later go last.
    const later = search || q?.wantsLater ? [] : open.filter((t) => startsLater(t, now));
    sections.push({ id: "open", title: null, rows: flat(open.filter((t) => !later.includes(t)).sort(sort), all) });
    if (later.length) sections.push({ id: "later", title: "Starts later", tone: "muted", rows: flat(later.sort(sort), all) });
  }

  if (done.length) sections.push({ id: "done", title: "Completed", tone: "muted", rows: flat(done.sort(compareDone), all) });
  return sections;
}

export function countOpen(
  view: ViewId,
  all: Task[],
  now = new Date(),
  opts: Pick<ViewOptions, "lists" | "savedSearches"> = {},
): number {
  const ctx = context(opts, now);
  const q = viewQuery(view, opts.savedSearches);
  let n = 0;
  for (const t of all) {
    if (t.completed || !inView(view, t, now, q, ctx)) continue;
    // Counts match the main section, without tasks that start later.
    if (view !== "upcoming" && !q?.wantsLater && startsLater(t, now)) continue;
    n++;
  }
  return n;
}

/** All tags in use, with the number of current open tasks carrying them. */
export function tagCounts(all: Task[], now = new Date()): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const t of all) {
    for (const c of t.categories) {
      const key = c.toLowerCase();
      const entry = counts.get(key) ?? { tag: c, count: 0 };
      if (!t.completed && !startsLater(t, now)) entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
}

/** Whether a task shows up in the given view (used to jump to a task). */
export function isInView(view: ViewId, t: Task, opts: Pick<ViewOptions, "lists" | "savedSearches"> = {}, now = new Date()) {
  return inView(view, t, now, viewQuery(view, opts.savedSearches), context(opts, now));
}
