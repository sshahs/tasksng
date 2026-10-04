import { parseDue } from "./dates";
import type { Task, TaskUpdate } from "./types";

export type SortMode = "smart" | "manual" | "due" | "priority" | "title" | "created";

export const SORT_MODES: { value: SortMode; label: string; listsOnly?: boolean }[] = [
  { value: "smart", label: "Due date, then priority" },
  { value: "manual", label: "Manual (drag and drop)", listsOnly: true },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "created", label: "Newest first" },
];

const dueKey = (t: Task) => {
  const d = parseDue(t.due);
  return d ? d.date.getTime() : Number.POSITIVE_INFINITY;
};
const prioKey = (t: Task) => (t.priority === 0 ? 10 : t.priority);
const created = (t: Task) => (t.created ? Date.parse(t.created) || 0 : 0);

/** Seconds between 1970 and 2001, the epoch Apple uses for X-APPLE-SORT-ORDER. */
const APPLE_EPOCH = 978_307_200;
export const ORDER_STEP = 1024;

/**
 * Position in manual order. Tasks without an explicit order sort by creation
 * time, which is what Apple Reminders writes for new items.
 */
export function manualKey(t: Task): number {
  if (t.sortOrder != null) return t.sortOrder;
  return t.created ? Math.floor(created(t) / 1000) - APPLE_EPOCH : 0;
}

const byTitle = (a: Task, b: Task) => a.summary.localeCompare(b.summary, undefined, { numeric: true, sensitivity: "base" });

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

export function comparator(mode: SortMode): (a: Task, b: Task) => number {
  switch (mode) {
    case "manual":
      return (a, b) => manualKey(a) - manualKey(b) || created(a) - created(b) || byTitle(a, b);
    case "priority":
      return (a, b) => prioKey(a) - prioKey(b) || compareOpen(a, b);
    case "title":
      return (a, b) => byTitle(a, b) || compareOpen(a, b);
    case "created":
      return (a, b) => created(b) - created(a) || byTitle(a, b);
    case "due":
    case "smart":
    default:
      return compareOpen;
  }
}

/**
 * Edits needed to put `moving` at `index` among `siblings` (shown in this
 * order, without `moving`) under `parentUid`. Uses a single write when there
 * is room between the neighbours, otherwise renumbers the group.
 */
export function planReorder(siblings: Task[], moving: Task, index: number, parentUid: string | null): TaskUpdate[] {
  const others = siblings.filter((t) => t.id !== moving.id);
  const at = Math.max(0, Math.min(index, others.length));
  const seq = [...others.slice(0, at), moving, ...others.slice(at)];
  const parentChanged = (moving.parentUid ?? null) !== parentUid;
  const keys = others.map(manualKey);
  const increasing = keys.every((k, i) => i === 0 || k > keys[i - 1]);
  const prev = at > 0 ? keys[at - 1] : null;
  const next = at < keys.length ? keys[at] : null;

  let order: number | null = null;
  if (increasing) {
    if (prev === null && next === null) order = manualKey(moving);
    else if (prev === null) order = next! - ORDER_STEP;
    else if (next === null) order = prev + ORDER_STEP;
    else if (next - prev >= 2) order = Math.floor((prev + next) / 2);
  }
  if (order !== null) {
    const patch: TaskUpdate["patch"] = {};
    if (order !== moving.sortOrder) patch.sortOrder = order;
    if (parentChanged) patch.parentUid = parentUid;
    return Object.keys(patch).length ? [{ id: moving.id, patch }] : [];
  }
  // No room (or the list was sorted differently until now): renumber.
  const base = Math.min(...seq.map(manualKey).filter(Number.isFinite), 0);
  const updates: TaskUpdate[] = [];
  seq.forEach((t, i) => {
    const sortOrder = base + (i + 1) * ORDER_STEP;
    const patch: TaskUpdate["patch"] = {};
    if (t.sortOrder !== sortOrder) patch.sortOrder = sortOrder;
    if (t.id === moving.id && parentChanged) patch.parentUid = parentUid;
    if (Object.keys(patch).length) updates.push({ id: t.id, patch });
  });
  return updates;
}
