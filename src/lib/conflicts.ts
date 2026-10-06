import { formatDue, parseDue } from "./dates";
import { reminderLabel } from "./reminders";
import { describeRule } from "./rrule";
import type { ConflictView, Resolution, Task, TaskPatch } from "./types";

export type Side = "mine" | "theirs";

/** One field that can differ between two versions of a task. */
export interface ConflictField {
  key: string;
  label: string;
  same(a: Task, b: Task): boolean;
  /** How the field reads (`others`: other tasks, for the parent's title). */
  show(t: Task, others: Record<string, Task>): string;
  /** The patch that gives a task this version's value. */
  patch(t: Task): TaskPatch;
}

const STATUS: Record<Task["status"], string> = {
  "needs-action": "To do",
  "in-process": "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};

function priority(p: number): string {
  if (p >= 1 && p <= 4) return "High";
  if (p === 5) return "Medium";
  if (p >= 6 && p <= 9) return "Low";
  return "None";
}

function when(value: string | null, none: string): string {
  const info = parseDue(value);
  return info ? formatDue(info) : none;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const FIELDS: ConflictField[] = [
  {
    key: "summary",
    label: "Title",
    same: (a, b) => a.summary === b.summary,
    show: (t) => t.summary || "Untitled task",
    patch: (t) => ({ summary: t.summary }),
  },
  {
    key: "status",
    label: "Status",
    same: (a, b) => a.status === b.status,
    show: (t) => STATUS[t.status],
    patch: (t) => ({ status: t.status }),
  },
  {
    key: "due",
    label: "Due",
    same: (a, b) => a.due === b.due,
    show: (t) => when(t.due, "No due date"),
    patch: (t) => ({ due: t.due }),
  },
  {
    key: "start",
    label: "Start",
    same: (a, b) => a.start === b.start,
    show: (t) => when(t.start, "No start date"),
    patch: (t) => ({ start: t.start }),
  },
  {
    key: "priority",
    label: "Priority",
    same: (a, b) => priority(a.priority) === priority(b.priority),
    show: (t) => priority(t.priority),
    patch: (t) => ({ priority: t.priority }),
  },
  {
    key: "rrule",
    label: "Repeat",
    same: (a, b) => (a.rrule ?? "") === (b.rrule ?? ""),
    show: (t) => describeRule(t.rrule) ?? "Does not repeat",
    patch: (t) => ({ rrule: t.rrule }),
  },
  {
    key: "categories",
    label: "Tags",
    same: (a, b) => sameList(a.categories, b.categories),
    show: (t) => (t.categories.length ? t.categories.map((c) => `#${c}`).join(" ") : "No tags"),
    patch: (t) => ({ categories: t.categories }),
  },
  {
    key: "reminders",
    label: "Reminders",
    same: (a, b) => JSON.stringify(a.reminders) === JSON.stringify(b.reminders),
    show: (t) => (t.reminders.length ? t.reminders.map((r) => reminderLabel(r, t)).join(", ") : "No reminders"),
    patch: (t) => ({ reminders: t.reminders }),
  },
  {
    key: "planned",
    label: "Planned",
    same: (a, b) => a.planned === b.planned && (a.plannedMinutes ?? 0) === (b.plannedMinutes ?? 0),
    show: (t) => {
      const at = parseDue(t.planned);
      if (!at) return "Not planned";
      return `${formatDue(at)} for ${t.plannedMinutes ?? 30} min`;
    },
    patch: (t) => ({ planned: t.planned, plannedMinutes: t.plannedMinutes }),
  },
  {
    key: "parentUid",
    label: "Subtask of",
    same: (a, b) => a.parentUid === b.parentUid,
    show: (t, others) => {
      if (!t.parentUid) return "Not a subtask";
      const parent = Object.values(others).find((o) => o.uid === t.parentUid);
      return parent?.summary || "Another task";
    },
    patch: (t) => ({ parentUid: t.parentUid }),
  },
  {
    key: "description",
    label: "Notes",
    same: (a, b) => a.description.trim() === b.description.trim(),
    show: (t) => t.description.trim() || "No notes",
    patch: (t) => ({ description: t.description || null }),
  },
];

/** The fields the two versions disagree on. */
export function differingFields(mine: Task, theirs: Task): ConflictField[] {
  return FIELDS.filter((f) => !f.same(mine, theirs));
}

/** Starts from the version that was changed last, field by field. */
export function defaultPicks(c: ConflictView): Record<string, Side> {
  if (!c.mine || !c.theirs) return {};
  const mineNewer = (c.mine.modified ?? "") >= (c.theirs.modified ?? "");
  return Object.fromEntries(differingFields(c.mine, c.theirs).map((f) => [f.key, mineNewer ? "mine" : "theirs"]));
}

/** What to send for the user's picks: one whole side, or theirs with some of ours. */
export function resolutionFor(c: ConflictView, picks: Record<string, Side>): Resolution {
  if (!c.mine || !c.theirs) return { keep: picks.all === "mine" ? "mine" : "theirs" };
  const fields = differingFields(c.mine, c.theirs);
  const ours = fields.filter((f) => (picks[f.key] ?? "theirs") === "mine");
  if (ours.length === 0) return { keep: "theirs" };
  if (ours.length === fields.length) return { keep: "mine" };
  const mine = c.mine;
  return { keep: "merge", patch: Object.assign({}, ...ours.map((f) => f.patch(mine))) as TaskPatch };
}
