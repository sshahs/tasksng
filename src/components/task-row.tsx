import { memo } from "react";
import {
  CalendarIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  ListTreeIcon,
  RepeatIcon,
  StickyNoteIcon,
} from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { formatDue, isDueToday, isOverdue, parseDue } from "@/lib/dates";
import { useStore } from "@/lib/store";
import type { Task, TaskList } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PriorityFlag, priorityBorder, priorityLevel } from "./priority";

export interface TaskRowProps {
  task: Task;
  depth: number;
  childCount: number;
  childDone: number;
  hasVisibleChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  /** Shown in smart views where tasks of several lists are mixed. */
  list: TaskList | null;
  readOnly: boolean;
}

export const TaskRow = memo(function TaskRow({
  task,
  depth,
  childCount,
  childDone,
  hasVisibleChildren,
  collapsed,
  selected,
  list,
  readOnly,
}: TaskRowProps) {
  const due = parseDue(task.due);
  const overdue = !task.completed && isOverdue(due);
  const today = !task.completed && isDueToday(due);
  const level = priorityLevel(task.priority);
  const hasMeta =
    !!due || !!task.rrule || !!list || childCount > 0 || !!task.description || task.categories.length > 0 || task.pending;

  const select = () => useStore.getState().select(task.id);

  return (
    <div
      role="option"
      aria-selected={selected}
      data-task-id={task.id}
      onMouseDown={select}
      onContextMenu={select}
      onDoubleClick={() => useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 }))}
      className={cn(
        "group relative flex cursor-default items-start gap-2 rounded-md px-2 py-[7px] text-sm transition-colors",
        "hover:bg-accent/60",
        selected && "bg-accent hover:bg-accent",
      )}
      style={{ paddingLeft: 8 + depth * 22 }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={collapsed ? "Expand subtasks" : "Collapse subtasks"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => useStore.getState().toggleCollapsed(task.uid)}
        className={cn(
          "text-muted-foreground hover:text-foreground -ml-1 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm",
          !(hasVisibleChildren || (collapsed && childCount > 0)) && "invisible",
        )}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
      </button>
      <Checkbox
        checked={task.completed}
        disabled={readOnly}
        onMouseDown={(e) => e.stopPropagation()}
        onCheckedChange={() => void useStore.getState().toggleComplete(task.id)}
        aria-label={task.completed ? "Mark as not done" : "Mark as done"}
        className={cn(
          "mt-px size-[18px] rounded-full border-[1.5px] shadow-none transition-colors",
          priorityBorder[level],
          !task.completed && "hover:bg-accent",
        )}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate leading-5",
            task.completed && "text-muted-foreground line-through decoration-muted-foreground/60",
            !task.summary && "text-muted-foreground italic",
          )}
        >
          {task.summary || "Untitled task"}
        </div>
        {hasMeta && (
          <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-x-3 gap-y-0.5 text-xs leading-4">
            {list && (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />
                <span className="truncate">{list.name}</span>
              </span>
            )}
            {due && (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1",
                  overdue && "text-destructive",
                  today && !overdue && "text-primary",
                )}
              >
                <CalendarIcon className="size-3" />
                {formatDue(due)}
              </span>
            )}
            {task.rrule && <RepeatIcon className="size-3 shrink-0" aria-label="Repeats" />}
            {childCount > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                <ListTreeIcon className="size-3" />
                {childDone}/{childCount}
              </span>
            )}
            {task.description && <StickyNoteIcon className="size-3 shrink-0" aria-label="Has notes" />}
            {task.categories.length > 0 && (
              <span className="truncate">{task.categories.map((c) => `#${c}`).join(" ")}</span>
            )}
            {task.pending && (
              <CloudUploadIcon className="text-muted-foreground/70 size-3 shrink-0" aria-label="Waiting to sync" />
            )}
          </div>
        )}
      </div>
      <PriorityFlag priority={task.priority} className="mt-[3px] shrink-0" />
    </div>
  );
});
