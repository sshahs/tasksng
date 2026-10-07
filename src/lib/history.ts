import { format, isSameDay, subDays } from "date-fns";

import { differingFields, type ConflictField } from "./conflicts";
import type { Task, TaskPatch, TaskVersion, VersionSource } from "./types";

const SOURCE: Record<VersionSource, string> = {
  created: "Created",
  here: "Changed here",
  elsewhere: "Changed on another device",
  earlier: "How it was",
};

export function sourceLabel(s: VersionSource): string {
  return SOURCE[s];
}

/** "Today 14:03", "Yesterday 09:12", "Mon 6 Oct 18:30". */
export function versionTime(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  if (isSameDay(d, now)) return `Today ${format(d, "HH:mm")}`;
  if (isSameDay(d, subDays(now, 1))) return `Yesterday ${format(d, "HH:mm")}`;
  return format(d, d.getFullYear() === now.getFullYear() ? "EEE d MMM HH:mm" : "d MMM yyyy HH:mm");
}

/** What a version changed compared with the one before it (versions are newest first). */
export function changesIn(versions: TaskVersion[], i: number): ConflictField[] {
  const older = versions[i + 1];
  return older ? differingFields(older.task, versions[i].task) : [];
}

/** The patch that turns `current` back into `version`, or null when they look the same. */
export function restorePatch(current: Task, version: Task): TaskPatch | null {
  const fields = differingFields(current, version);
  if (!fields.length) return null;
  return Object.assign({}, ...fields.map((f) => f.patch(version))) as TaskPatch;
}
