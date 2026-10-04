import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarIcon,
  CloudUploadIcon,
  CornerLeftUpIcon,
  FlagIcon,
  ListTreeIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RepeatIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { formatTimestamp } from "@/lib/dates";
import { useStore } from "@/lib/store";
import type { Task, TaskPatch } from "@/lib/types";
import { cn } from "@/lib/utils";
import { compareOpen } from "@/lib/views";
import { DuePicker } from "./due-picker";
import { PRIORITIES, PriorityFlag, priorityBorder, priorityLevel } from "./priority";
import { REPEAT_OPTIONS, repeatValue } from "./repeat";
import { TagInput } from "./tag-input";

export function TaskDetail() {
  const selectedId = useStore((s) => s.selectedId);
  const task = useStore((s) => (s.selectedId ? s.tasks[s.selectedId] : undefined));
  if (!selectedId || !task) return null;
  return (
    <aside
      className={cn(
        "bg-background flex h-full w-[360px] shrink-0 flex-col border-l",
        // Overlay instead of squeezing the list on narrow windows.
        "max-[980px]:absolute max-[980px]:inset-y-0 max-[980px]:right-0 max-[980px]:z-30 max-[980px]:shadow-2xl",
      )}
      aria-label="Task details"
    >
      <DetailBody key={task.id} task={task} />
    </aside>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-1">
      <div className="text-muted-foreground flex w-8 shrink-0 justify-center [&_svg]:size-4">{icon}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function DetailBody({ task }: { task: Task }) {
  const lists = useStore((s) => s.lists);
  const tasks = useStore((s) => s.tasks);
  const focusTitle = useStore((s) => s.focusTitle);
  const list = lists.find((l) => l.id === task.listId);
  const readOnly = !!list?.readOnly;
  const [title, setTitle] = useState(task.summary);
  const [notes, setNotes] = useState(task.description);
  const [subtask, setSubtask] = useState("");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const editingTitle = useRef(false);
  const editingNotes = useRef(false);
  const notesTimer = useRef<number | undefined>(undefined);
  const focusSeen = useRef(focusTitle);

  const update = (patch: TaskPatch) => void useStore.getState().updateTask(task.id, patch);

  // Pick up remote changes unless the user is typing in that field.
  useEffect(() => {
    if (!editingTitle.current) setTitle(task.summary);
  }, [task.summary]);
  useEffect(() => {
    if (!editingNotes.current) setNotes(task.description);
  }, [task.description]);

  useEffect(() => {
    if (focusTitle !== focusSeen.current) {
      focusSeen.current = focusTitle;
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [focusTitle]);

  const commitTitle = () => {
    const v = title.replace(/\s+/g, " ").trim();
    if (!v) setTitle(task.summary);
    else if (v !== task.summary) update({ summary: v });
  };
  const commitNotes = (value = notes) => {
    window.clearTimeout(notesTimer.current);
    if (value !== task.description) update({ description: value || null });
  };
  // Flush unsaved notes when switching tasks.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useEffect(
    () => () => {
      window.clearTimeout(notesTimer.current);
      if (editingNotes.current && notesRef.current !== task.description) {
        void useStore.getState().updateTask(task.id, { description: notesRef.current || null });
      }
    },
    [],
  );

  const subtasks = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => t.parentUid === task.uid && t.listId === task.listId)
        .sort((a, b) => Number(a.completed) - Number(b.completed) || compareOpen(a, b)),
    [tasks, task.uid, task.listId],
  );
  const parent = useMemo(
    () =>
      task.parentUid ? Object.values(tasks).find((t) => t.uid === task.parentUid && t.listId === task.listId) : undefined,
    [tasks, task.parentUid, task.listId],
  );

  const addSubtask = async () => {
    const summary = subtask.trim();
    if (!summary) return;
    setSubtask("");
    await useStore.getState().createTask(task.listId, { summary, parentUid: task.uid });
  };

  const repeat = repeatValue(task.rrule);
  const created = formatTimestamp(task.created);
  const modified = formatTimestamp(task.modified);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <Select
          value={task.listId}
          disabled={readOnly}
          onValueChange={(id) => void useStore.getState().moveTask(task.id, id)}
        >
          <SelectTrigger size="sm" className="h-8 max-w-56 border-none shadow-none" aria-label="List">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {lists
              .filter((l) => !l.readOnly || l.id === task.listId)
              .map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: l.color ?? "var(--muted-foreground)" }} />
                  <span className="truncate">{l.name}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        {task.pending && (
          <span className="text-muted-foreground mr-1 flex items-center gap-1 text-xs" title="Waiting to sync">
            <CloudUploadIcon className="size-3.5" />
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {parent && (
              <DropdownMenuItem disabled={readOnly} onSelect={() => update({ parentUid: null })}>
                <UnlinkIcon /> Make top-level task
              </DropdownMenuItem>
            )}
            {parent && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant="destructive"
              disabled={readOnly}
              onSelect={() => {
                void useStore.getState().deleteTasks([task.id]);
                useStore.getState().select(null);
              }}
            >
              <Trash2Icon /> Delete task
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={() => useStore.getState().select(null)}
          aria-label="Close details"
        >
          <XIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {parent && (
          <button
            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-5 pt-3 text-left text-xs"
            onClick={() => useStore.getState().select(parent.id)}
          >
            <CornerLeftUpIcon className="size-3.5 shrink-0" />
            <span className="truncate">{parent.summary || "Untitled task"}</span>
          </button>
        )}
        <div className="flex items-start gap-3 px-5 pt-4 pb-2">
          <Checkbox
            checked={task.completed}
            disabled={readOnly}
            onCheckedChange={() => void useStore.getState().toggleComplete(task.id)}
            className={cn("mt-1 size-5 rounded-full border-[1.5px] shadow-none", priorityBorder[priorityLevel(task.priority)])}
            aria-label="Done"
          />
          <textarea
            ref={titleRef}
            value={title}
            readOnly={readOnly}
            rows={1}
            onFocus={() => (editingTitle.current = true)}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
            onBlur={() => {
              editingTitle.current = false;
              commitTitle();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setTitle(task.summary);
                editingTitle.current = false;
                requestAnimationFrame(() => titleRef.current?.blur());
              }
            }}
            placeholder="Task title"
            aria-label="Title"
            className={cn(
              "placeholder:text-muted-foreground field-sizing-content min-h-7 flex-1 resize-none bg-transparent text-lg leading-7 font-semibold outline-none",
              task.completed && "text-muted-foreground line-through",
            )}
          />
        </div>

        <div className="px-3 py-1">
          <Row icon={<CalendarIcon />}>
            <DuePicker value={task.due} completed={task.completed} showIcon={false} onChange={(due) => update({ due })} />
          </Row>
          <Row icon={<RepeatIcon />}>
            <Select
              value={repeat}
              disabled={readOnly}
              onValueChange={(v) => {
                const opt = REPEAT_OPTIONS.find((o) => o.value === v);
                if (opt) update({ rrule: opt.rrule });
              }}
            >
              <SelectTrigger size="sm" className="h-8 w-full border-none px-2 shadow-none dark:bg-transparent" aria-label="Repeat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPEAT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
                {repeat === "custom" && (
                  <SelectItem value="custom" disabled>
                    Custom ({task.rrule})
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </Row>
          <Row icon={<FlagIcon />}>
            <Select
              value={String(PRIORITIES.find((p) => p.level === priorityLevel(task.priority))?.value ?? 0)}
              disabled={readOnly}
              onValueChange={(v) => update({ priority: Number(v) })}
            >
              <SelectTrigger size="sm" className="h-8 w-full border-none px-2 shadow-none dark:bg-transparent" aria-label="Priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p.level} value={String(p.value)}>
                    {p.value > 0 && <PriorityFlag priority={p.value} className="size-4" />}
                    {p.label === "None" ? "No priority" : `${p.label} priority`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <div className="-ml-1">
            <TagInput value={task.categories} onChange={(categories) => update({ categories })} />
          </div>
        </div>

        <Separator className="my-2" />

        <div className="px-5 py-2">
          <Textarea
            value={notes}
            readOnly={readOnly}
            placeholder="Add notes"
            onFocus={() => (editingNotes.current = true)}
            onChange={(e) => {
              const v = e.target.value;
              setNotes(v);
              window.clearTimeout(notesTimer.current);
              notesTimer.current = window.setTimeout(() => commitNotes(v), 800);
            }}
            onBlur={() => {
              editingNotes.current = false;
              commitNotes();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            className="min-h-24 resize-none border-none bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            aria-label="Notes"
          />
        </div>

        <Separator className="my-2" />

        <div className="px-3 pt-1 pb-4">
          <div className="text-muted-foreground flex items-center gap-2 px-2 pb-1 text-xs font-medium tracking-wide uppercase">
            <ListTreeIcon className="size-3.5" /> Subtasks
            {subtasks.length > 0 && (
              <span className="font-normal normal-case">
                {subtasks.filter((s) => s.completed).length}/{subtasks.length}
              </span>
            )}
          </div>
          {subtasks.map((s) => (
            <div key={s.id} className="hover:bg-accent/60 group flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <Checkbox
                checked={s.completed}
                disabled={readOnly}
                onCheckedChange={() => void useStore.getState().toggleComplete(s.id)}
                className={cn("size-4 rounded-full shadow-none", priorityBorder[priorityLevel(s.priority)])}
                aria-label={`Done: ${s.summary}`}
              />
              <button
                className={cn(
                  "min-w-0 flex-1 truncate text-left text-sm",
                  s.completed && "text-muted-foreground line-through",
                )}
                onClick={() => useStore.getState().select(s.id)}
              >
                {s.summary || "Untitled task"}
              </button>
              <PriorityFlag priority={s.priority} />
            </div>
          ))}
          {!readOnly && (
            <div className="flex items-center gap-2.5 px-2 py-1">
              <PlusIcon className="text-muted-foreground size-4" />
              <input
                value={subtask}
                onChange={(e) => setSubtask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addSubtask();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setSubtask("");
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Add subtask"
                className="placeholder:text-muted-foreground h-7 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
          )}
        </div>
      </div>

      {(created || modified) && (
        <div className="text-muted-foreground shrink-0 border-t px-5 py-2.5 text-xs">
          {created && <>Created {created}</>}
          {created && modified && " · "}
          {modified && <>Edited {modified}</>}
        </div>
      )}
    </>
  );
}
