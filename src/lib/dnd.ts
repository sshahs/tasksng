import { create } from "zustand";

import { comparator, planReorder } from "./sort";
import type { Task, TaskUpdate } from "./types";
import type { Row } from "./views";

export type DropPos = "before" | "after" | "inside";

export type DropTarget =
  | { kind: "row"; id: string; pos: DropPos }
  | { kind: "list"; id: string }
  | { kind: "view"; id: "today" | "important" }
  | { kind: "tag"; tag: string };

interface DragState {
  /** Task being dragged. */
  id: string | null;
  over: DropTarget | null;
}

export const useDrag = create<DragState>()(() => ({ id: null, over: null }));

export const DRAG_TYPE = "application/x-tasksng-task";

/** Whether `uid` is `ancestor` itself or one of its subtasks (at any depth). */
export function isDescendant(all: Task[], task: Task, ancestorUid: string): boolean {
  const byUid = new Map(all.filter((t) => t.listId === task.listId).map((t) => [t.uid, t]));
  let cur: Task | undefined = task;
  for (let i = 0; cur && i < 100; i++) {
    if (cur.uid === ancestorUid) return true;
    cur = cur.parentUid ? byUid.get(cur.parentUid) : undefined;
  }
  return false;
}

const children = (all: Task[], parent: Task) =>
  all.filter((t) => t.parentUid === parent.uid && t.listId === parent.listId && !t.completed).sort(comparator("manual"));

export interface DropPlan {
  updates: TaskUpdate[];
  /** The drop reordered tasks, so the list switches to manual order. */
  reordered: boolean;
  /** Parent that should be expanded to show the result. */
  expand: string | null;
}

/**
 * Works out the edits for dropping `dragged` on a row of a list view.
 * `rows` are the rows shown (in order) in the list's open section.
 */
export function planDrop(
  dragged: Task,
  target: Task,
  pos: DropPos,
  rows: Row[],
  all: Task[],
  collapsed: Record<string, boolean>,
): DropPlan | null {
  if (dragged.id === target.id || dragged.listId !== target.listId) return null;
  if (isDescendant(all, target, dragged.uid)) return null;

  const targetRow = rows.find((r) => r.task.id === target.id);
  const expandedParent = pos === "after" && !!targetRow?.hasVisibleChildren && !collapsed[target.uid];
  if (pos === "inside" || expandedParent) {
    const kids = expandedParent
      ? rows.filter((r) => r.task.parentUid === target.uid && r.task.listId === target.listId).map((r) => r.task)
      : children(all, target);
    const index = expandedParent ? 0 : kids.filter((k) => k.id !== dragged.id).length;
    return { updates: planReorder(kids, dragged, index, target.uid), reordered: expandedParent, expand: target.uid };
  }

  if (!targetRow) return null;
  const parent = targetRow.depth === 0 ? null : (target.parentUid ?? null);
  const siblings = siblingsOf(rows, targetRow).filter((t) => t.id !== dragged.id);
  const at = siblings.findIndex((t) => t.id === target.id);
  if (at < 0) return null;
  return { updates: planReorder(siblings, dragged, pos === "before" ? at : at + 1, parent), reordered: true, expand: null };
}

/** Edits for Alt+arrow keys: move up/down among siblings, indent or outdent. */
export function planKeyboardMove(
  task: Task,
  dir: "up" | "down" | "in" | "out",
  rows: Row[],
  all: Task[],
): DropPlan | null {
  const row = rows.find((r) => r.task.id === task.id);
  if (!row) return null;
  const parentUid = row.depth === 0 ? null : (task.parentUid ?? null);
  const siblings = siblingsOf(rows, row);
  const idx = siblings.findIndex((t) => t.id === task.id);
  if (dir === "up" || dir === "down") {
    const others = siblings.filter((t) => t.id !== task.id);
    const index = dir === "up" ? idx - 1 : idx + 1;
    if (index < 0 || index > others.length) return null;
    return { updates: planReorder(others, task, index, parentUid), reordered: true, expand: null };
  }
  if (dir === "in") {
    const prev = siblings[idx - 1];
    if (!prev) return null;
    const kids = children(all, prev).filter((k) => k.id !== task.id);
    return { updates: planReorder(kids, task, kids.length, prev.uid), reordered: false, expand: prev.uid };
  }
  if (parentUid === null) return null;
  const parentRow = rows.find((r) => r.task.uid === parentUid && r.task.listId === task.listId);
  if (!parentRow) return null;
  const grand = parentRow.depth === 0 ? null : (parentRow.task.parentUid ?? null);
  const level = siblingsOf(rows, parentRow).filter((t) => t.id !== task.id);
  const at = level.findIndex((t) => t.id === parentRow.task.id);
  return { updates: planReorder(level, task, at + 1, grand), reordered: true, expand: null };
}

/** Tasks shown at the same level under the same parent, in display order. */
function siblingsOf(rows: Row[], row: Row): Task[] {
  if (row.depth === 0) return rows.filter((r) => r.depth === 0).map((r) => r.task);
  return rows.filter((r) => r.task.parentUid === row.task.parentUid && r.task.listId === row.task.listId).map((r) => r.task);
}
