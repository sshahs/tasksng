import { memo } from "react";
import {
  AlarmClockIcon,
  BellIcon,
  CalendarIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  GitCompareArrowsIcon,
  HourglassIcon,
  ListTreeIcon,
  RepeatIcon,
  StickyNoteIcon,
  XIcon,
} from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { isMobileLayout, isTouch } from "@/hooks/use-mobile";
import { formatDue, isDueToday, isOverdue, parseDue } from "@/lib/dates";
import { DRAG_TYPE, useDrag, type DropPos } from "@/lib/dnd";
import { startsLater } from "@/lib/search";
import { isSnoozed, snoozeLabel } from "@/lib/snooze";
import { useStore } from "@/lib/store";
import type { Task, TaskList } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PriorityFlag, priorityBorder, priorityFill, priorityLevel, priorityText } from "./priority";

/** Clicking row controls must neither select the row nor steal keyboard focus. */
function keepFocus(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/** Nor open the task's details on a phone. */
function stop(e: React.MouseEvent) {
  e.stopPropagation();
}

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
  /** Rows of a list's open section can be reordered and nested by dropping on them. */
  droppable: boolean;
  /** Ticked off a moment ago. */
  justDone: boolean;
  /** Changed on this device and another one; the user hasn't chosen yet. */
  conflict: boolean;
}

/** Where on a row the pointer is: top quarter = before, bottom = after, else inside. */
function dropPos(e: React.DragEvent<HTMLElement>): DropPos {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  return y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
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
  droppable,
  justDone,
  conflict,
}: TaskRowProps) {
  const due = parseDue(task.due);
  const start = parseDue(task.start);
  const overdue = !task.completed && isOverdue(due);
  const today = !task.completed && isDueToday(due);
  const later = !task.completed && startsLater(task, new Date());
  const level = priorityLevel(task.priority);
  const inProgress = task.status === "in-process";
  const cancelled = task.status === "cancelled";
  const dropping = useDrag((s) => (s.over?.kind === "row" && s.over.id === task.id ? s.over.pos : null));
  const dragging = useDrag((s) => s.id === task.id);
  const hasMeta =
    !!due ||
    later ||
    inProgress ||
    !!task.rrule ||
    !!list ||
    childCount > 0 ||
    !!task.description ||
    task.reminders.length > 0 ||
    task.categories.length > 0 ||
    task.pending ||
    conflict ||
    !!task.snoozedUntil;

  const select = () => useStore.getState().select(task.id);
  // Just ticked off: the circle pops, a ring goes out, the line draws through.
  const popping = justDone && task.completed;

  return (
    <div
      role="option"
      aria-selected={selected}
      data-task-id={task.id}
      // Long-pressing a row opens its menu on touch screens.
      draggable={!readOnly && !isTouch()}
      onMouseDown={select}
      onClick={() => isMobileLayout() && useStore.getState().openDetail(task.id)}
      onContextMenu={select}
      onDoubleClick={() => useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 }))}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.setData("text/plain", task.summary);
        e.dataTransfer.effectAllowed = "move";
        useDrag.setState({ id: task.id, over: null });
      }}
      onDragEnd={() => useDrag.setState({ id: null, over: null })}
      onDragOver={(e) => {
        const dragged = useDrag.getState().id;
        if (!droppable || !dragged || dragged === task.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const pos = dropPos(e);
        const over = useDrag.getState().over;
        if (over?.kind !== "row" || over.id !== task.id || over.pos !== pos) {
          useDrag.setState({ over: { kind: "row", id: task.id, pos } });
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        const over = useDrag.getState().over;
        if (over?.kind === "row" && over.id === task.id) useDrag.setState({ over: null });
      }}
      className={cn(
        "group relative flex cursor-default items-start gap-2 rounded-md px-2 py-[7px] text-sm transition-[background-color,opacity,box-shadow] max-md:py-2.5",
        "hover:bg-accent/60",
        selected && "bg-accent hover:bg-accent",
        dragging && "opacity-40",
        dropping === "inside" && "bg-primary/10 ring-primary/50 ring-2 ring-inset",
        later && !selected && "opacity-70",
      )}
      style={{ paddingLeft: 8 + depth * 22 }}
    >
      {(dropping === "before" || dropping === "after") && (
        <div
          aria-hidden
          className={cn(
            "bg-primary pointer-events-none absolute right-2 h-0.5 rounded-full",
            dropping === "before" ? "-top-px" : "-bottom-px",
          )}
          style={{ left: 8 + depth * 22 + 18 }}
        />
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-label={collapsed ? "Expand subtasks" : "Collapse subtasks"}
        onMouseDown={keepFocus}
        onClick={(e) => {
          stop(e);
          useStore.getState().toggleCollapsed(task.uid);
        }}
        className={cn(
          "text-muted-foreground hover:text-foreground relative -ml-1 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm after:absolute after:-inset-2",
          !(hasVisibleChildren || (collapsed && childCount > 0)) && "invisible",
        )}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
      </button>
      <div className="relative mt-px size-[18px] shrink-0">
        <Checkbox
          checked={task.completed}
          disabled={readOnly}
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={stop}
          onCheckedChange={() => void useStore.getState().toggleComplete(task.id)}
          aria-label={task.completed ? "Mark as not done" : "Mark as done"}
          className={cn(
            "relative size-[18px] rounded-full border-[1.5px] shadow-none after:absolute after:-inset-2.5",
            popping && "animate-check-pop",
            priorityBorder[level],
            !task.completed && "hover:bg-accent",
            cancelled && "data-[state=checked]:bg-muted-foreground data-[state=checked]:border-muted-foreground [&_svg]:hidden",
          )}
        />
        {inProgress && !task.completed && (
          // Half-filled circle: started but not finished.
          <span
            aria-hidden
            className={cn("pointer-events-none absolute inset-[4px] rounded-full", priorityFill[level])}
            style={{ clipPath: "inset(0 50% 0 0)" }}
          />
        )}
        {cancelled && (
          <XIcon aria-hidden className="text-background pointer-events-none absolute inset-[3px] size-3 stroke-[3]" />
        )}
        {popping && (
          <span
            aria-hidden
            className={cn(
              "animate-check-ring pointer-events-none absolute inset-0 rounded-full border-2 border-current",
              level === "none" ? "text-primary" : priorityText[level],
            )}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate leading-5 transition-colors duration-300",
            task.completed && "text-muted-foreground",
            !task.summary && "text-muted-foreground italic",
          )}
        >
          <span className={cn("strike", popping && "strike-draw")} data-done={task.completed}>
            {task.summary || "Untitled task"}
          </span>
        </div>
        {hasMeta && (
          <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-x-3 gap-y-0.5 text-xs leading-4">
            {list && (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />
                <span className="truncate">{list.name}</span>
              </span>
            )}
            {conflict && (
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 text-amber-600 hover:underline dark:text-amber-400"
                onMouseDown={keepFocus}
                onClick={(e) => {
                  stop(e);
                  useStore.getState().set({ conflictsOpen: true });
                }}
              >
                <GitCompareArrowsIcon className="size-3" />
                Changed on two devices
              </button>
            )}
            {task.snoozedUntil && !task.completed && isSnoozed(task) && (
              <span className="flex shrink-0 items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlarmClockIcon className="size-3" />
                Snoozed {snoozeLabel(task.snoozedUntil)}
              </span>
            )}
            {inProgress && !task.completed && <span className="text-primary shrink-0">In progress</span>}
            {cancelled && <span className="shrink-0">Cancelled</span>}
            {later && start && (
              <span className="flex shrink-0 items-center gap-1" title="Start date">
                <HourglassIcon className="size-3" />
                Starts {formatDue(start)}
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
            {task.reminders.length > 0 && !task.completed && <BellIcon className="size-3 shrink-0" aria-label="Has reminders" />}
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
