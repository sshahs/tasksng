import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BellIcon,
  CalendarIcon,
  CircleDashedIcon,
  CloudUploadIcon,
  CornerLeftUpIcon,
  FlagIcon,
  HourglassIcon,
  ListTreeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RepeatIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";

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
import { useIsMobile } from "@/hooks/use-mobile";
import { formatTimestamp } from "@/lib/dates";
import { toggleChecklistLine } from "@/lib/markdown";
import { fade } from "@/lib/motion";
import { describeRule } from "@/lib/rrule";
import { useStore } from "@/lib/store";
import type { Task, TaskPatch } from "@/lib/types";
import { cn } from "@/lib/utils";
import { compareOpen } from "@/lib/views";
import { DuePicker } from "./due-picker";
import { Markdown } from "./markdown";
import { PRIORITIES, PriorityFlag, priorityBorder, priorityLevel } from "./priority";
import { ReminderPicker } from "./reminder-picker";
import { REPEAT_OPTIONS, repeatValue } from "./repeat";
import { RepeatEditor } from "./repeat-editor";
import { STATUSES } from "./status";
import { TagInput } from "./tag-input";

/**
 * The details slide in from the right: beside the list, over it on narrow
 * windows, and over the whole screen on phones like a new page. Transforms
 * only; the list makes room at once instead of on every frame.
 */
export function TaskDetail() {
  const selectedId = useStore((s) => s.selectedId);
  const task = useStore((s) => (s.selectedId ? s.tasks[s.selectedId] : undefined));
  const detailOpen = useStore((s) => s.detailOpen);
  const mobile = useIsMobile();
  const open = !!selectedId && !!task && (!mobile || detailOpen);
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {open && (
        <m.aside
          key="detail"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          className={cn(
            "bg-background z-20 flex h-full shrink-0 flex-col overflow-hidden border-l",
            // Overlay instead of squeezing the list on narrow windows …
            "md:max-[980px]:absolute md:max-[980px]:inset-y-0 md:max-[980px]:right-0 md:max-[980px]:z-30 md:max-[980px]:shadow-2xl",
            // … and the whole screen on phones.
            "max-md:fixed max-md:inset-0 max-md:z-30 max-md:border-l-0",
          )}
          aria-label="Task details"
        >
          {/* Keeps its width while the panel opens, so nothing inside reflows. */}
          <m.div
            key={task.id}
            className="flex h-full w-[360px] flex-col max-md:w-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={fade}
          >
            <DetailBody task={task} mobile={mobile} />
          </m.div>
        </m.aside>
      )}
    </AnimatePresence>
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

function DetailBody({ task, mobile }: { task: Task; mobile: boolean }) {
  const lists = useStore((s) => s.lists);
  const tasks = useStore((s) => s.tasks);
  const focusTitle = useStore((s) => s.focusTitle);
  const list = lists.find((l) => l.id === task.listId);
  const readOnly = !!list?.readOnly;
  const [title, setTitle] = useState(task.summary);
  const [notes, setNotes] = useState(task.description);
  const [subtask, setSubtask] = useState("");
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [notesMode, setNotesMode] = useState<"view" | "edit">("view");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
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
  // Switching tasks unmounts this pane without a reliable blur, so flush
  // whatever is still being edited.
  const draft = useRef({ title, notes });
  draft.current = { title, notes };
  useEffect(
    () => () => {
      window.clearTimeout(notesTimer.current);
      const latest = useStore.getState().tasks[task.id];
      if (!latest) return;
      const patch: TaskPatch = {};
      const t = draft.current.title.replace(/\s+/g, " ").trim();
      if (editingTitle.current && t && t !== latest.summary) patch.summary = t;
      if (editingNotes.current && draft.current.notes !== latest.description) patch.description = draft.current.notes || null;
      if (Object.keys(patch).length) void useStore.getState().updateTask(task.id, patch);
    },
    [task.id],
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
        {mobile && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground -ml-1"
            onClick={() => useStore.getState().select(null)}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        )}
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
        {!mobile && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => useStore.getState().select(null)}
            aria-label="Close details"
          >
            <XIcon />
          </Button>
        )}
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
            className={cn(
              "mt-1 size-5 rounded-full border-[1.5px] shadow-none",
              priorityBorder[priorityLevel(task.priority)],
              task.status === "cancelled" &&
                "data-[state=checked]:bg-muted-foreground data-[state=checked]:border-muted-foreground",
            )}
            aria-label={task.status === "cancelled" ? "Cancelled" : "Done"}
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
          <Row icon={<HourglassIcon />}>
            <DuePicker
              value={task.start}
              completed={task.completed}
              showIcon={false}
              placeholder="Add start date"
              prefix="Starts"
              warnOverdue={false}
              disabled={readOnly}
              onChange={(start) => update({ start })}
            />
          </Row>
          <Row icon={<BellIcon />}>
            <ReminderPicker task={task} readOnly={readOnly} onChange={(reminders) => update({ reminders })} />
          </Row>
          <Row icon={<RepeatIcon />}>
            <Select
              value={repeat}
              disabled={readOnly}
              onValueChange={(v) => {
                if (v === "edit") {
                  setRepeatOpen(true);
                  return;
                }
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
                {repeat === "custom" && <SelectItem value="custom">{describeRule(task.rrule)}</SelectItem>}
                <SelectItem value="edit">
                  <PencilIcon /> Custom…
                </SelectItem>
              </SelectContent>
            </Select>
            <RepeatEditor
              open={repeatOpen}
              onOpenChange={setRepeatOpen}
              rrule={task.rrule}
              due={task.due ?? task.start}
              onSave={(rrule) => update({ rrule })}
            />
          </Row>
          <Row icon={<CircleDashedIcon />}>
            <Select
              value={task.status}
              disabled={readOnly}
              onValueChange={(v) => update({ status: v as Task["status"] })}
            >
              <SelectTrigger size="sm" className="h-8 w-full border-none px-2 shadow-none dark:bg-transparent" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((st) => (
                  <SelectItem key={st.value} value={st.value}>
                    {st.icon} {st.label}
                    {task.rrule && (st.value === "completed" || st.value === "cancelled") && (
                      <span className="text-muted-foreground text-xs">
                        {st.value === "completed" ? "· moves to next" : "· skips this one"}
                      </span>
                    )}
                  </SelectItem>
                ))}
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
          {notesMode === "view" && notes.trim() ? (
            <div
              role="button"
              tabIndex={readOnly ? -1 : 0}
              aria-label="Notes (click to edit)"
              className={cn("-mx-2 min-h-24 cursor-text rounded-md px-2 py-1.5", !readOnly && "hover:bg-accent/40")}
              onClick={() => {
                if (readOnly) return;
                setNotesMode("edit");
                requestAnimationFrame(() => {
                  const el = notesRef.current;
                  el?.focus();
                  el?.setSelectionRange(el.value.length, el.value.length);
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !readOnly) {
                  e.preventDefault();
                  setNotesMode("edit");
                  requestAnimationFrame(() => notesRef.current?.focus());
                }
              }}
            >
              <Markdown
                source={notes}
                readOnly={readOnly}
                onToggle={(line) => {
                  const next = toggleChecklistLine(notes, line);
                  setNotes(next);
                  commitNotes(next);
                }}
              />
            </div>
          ) : (
            <>
              <Textarea
                ref={notesRef}
                value={notes}
                readOnly={readOnly}
                placeholder="Add notes"
                onFocus={() => {
                  editingNotes.current = true;
                  setNotesMode("edit");
                }}
                onChange={(e) => {
                  const v = e.target.value;
                  setNotes(v);
                  window.clearTimeout(notesTimer.current);
                  notesTimer.current = window.setTimeout(() => commitNotes(v), 800);
                }}
                onBlur={() => {
                  editingNotes.current = false;
                  commitNotes();
                  setNotesMode("view");
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
              {notesMode === "edit" && (
                <p className="text-muted-foreground/80 animate-in fade-in-0 slide-in-from-top-1 mt-1 text-[11px] duration-300">
                  **bold** · _italic_ · - list · - [ ] checklist · [link](https://…)
                </p>
              )}
            </>
          )}
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
          <AnimatePresence initial={false}>
            {subtasks.map((s) => (
              <m.div
                key={s.id}
                layout="position"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="hover:bg-accent/60 group flex items-center gap-2.5 overflow-hidden rounded-md px-2 py-1.5 transition-colors"
              >
                <Checkbox
                  checked={s.completed}
                  disabled={readOnly}
                  onCheckedChange={() => void useStore.getState().toggleComplete(s.id)}
                  className={cn("size-4 rounded-full shadow-none", priorityBorder[priorityLevel(s.priority)])}
                  aria-label={`Done: ${s.summary}`}
                />
                <button
                  className={cn(
                    "min-w-0 flex-1 truncate text-left text-sm transition-colors duration-300",
                    s.completed && "text-muted-foreground",
                  )}
                  onClick={() => useStore.getState().select(s.id)}
                >
                  <span className="strike" data-done={s.completed}>
                    {s.summary || "Untitled task"}
                  </span>
                </button>
                <PriorityFlag priority={s.priority} />
              </m.div>
            ))}
          </AnimatePresence>
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
