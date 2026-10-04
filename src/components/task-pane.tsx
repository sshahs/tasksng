import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, format, nextMonday } from "date-fns";
import {
  ArrowRightLeftIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CircleIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FlagIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDayKey } from "@/hooks/use-day-key";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { dateOnly } from "@/lib/dates";
import { listIdOf, SMART_VIEWS, useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";
import { buildSections } from "@/lib/views";
import { PRIORITIES, PriorityFlag } from "./priority";
import { QuickAdd } from "./quick-add";
import { TaskRow } from "./task-row";

export function TaskPane() {
  const view = useStore((s) => s.view);
  const tasks = useStore((s) => s.tasks);
  const lists = useStore((s) => s.lists);
  const search = useStore((s) => s.search);
  const showCompleted = useStore((s) => s.showCompleted);
  const collapsed = useStore((s) => s.collapsed);
  const selectedId = useStore((s) => s.selectedId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const focusSearch = useStore((s) => s.focusSearch);
  const dayKey = useDayKey();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [confirmDeleteList, setConfirmDeleteList] = useState(false);

  const listId = listIdOf(view);
  const list = listId ? (lists.find((l) => l.id === listId) ?? null) : null;
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const all = useMemo(() => Object.values(tasks), [tasks]);
  const sections = useMemo(
    () => buildSections(view, all, { search, showCompleted, collapsed }),
    [view, all, search, showCompleted, collapsed, dayKey],
  );
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const openCount = rows.filter((r) => !r.task.completed).length;
  const selected = selectedId ? tasks[selectedId] : undefined;

  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);

  // Keep the selected row visible during keyboard navigation.
  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector(`[data-task-id="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const idx = rows.findIndex((r) => r.task.id === selectedId);
    const next = idx < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + delta));
    useStore.getState().select(rows[next].task.id);
  };

  const deleteSelected = () => {
    if (!selected) return;
    const idx = rows.findIndex((r) => r.task.id === selected.id);
    const neighbour = rows[idx + 1] ?? rows[idx - 1];
    void useStore.getState().deleteTasks([selected.id]);
    useStore.getState().select(neighbour && neighbour.task.parentUid !== selected.uid ? neighbour.task.id : null);
  };

  useHotkeys([
    { keys: "arrowdown", handler: () => move(1) },
    { keys: "j", handler: () => move(1) },
    { keys: "arrowup", handler: () => move(-1) },
    { keys: "k", handler: () => move(-1) },
    { keys: "home", handler: () => rows[0] && useStore.getState().select(rows[0].task.id) },
    { keys: "end", handler: () => rows.length && useStore.getState().select(rows[rows.length - 1].task.id) },
    { keys: "space", handler: () => selected && void useStore.getState().toggleComplete(selected.id) },
    { keys: "mod+enter", handler: () => selected && void useStore.getState().toggleComplete(selected.id) },
    { keys: "enter", handler: () => selected && useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 })) },
    { keys: "f2", handler: () => selected && useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 })) },
    { keys: "delete", handler: deleteSelected },
    { keys: "1", handler: () => selected && void useStore.getState().updateTask(selected.id, { priority: 1 }) },
    { keys: "2", handler: () => selected && void useStore.getState().updateTask(selected.id, { priority: 5 }) },
    { keys: "3", handler: () => selected && void useStore.getState().updateTask(selected.id, { priority: 9 }) },
    { keys: "0", handler: () => selected && void useStore.getState().updateTask(selected.id, { priority: 0 }) },
    { keys: "t", handler: () => selected && void useStore.getState().updateTask(selected.id, { due: dateOnly(new Date()) }) },
    {
      keys: "m",
      handler: () => selected && void useStore.getState().updateTask(selected.id, { due: dateOnly(addDays(new Date(), 1)) }),
    },
    {
      keys: "escape",
      handler: () => {
        const s = useStore.getState();
        if (s.search) s.set({ search: "" });
        else s.select(null);
      },
    },
  ]);

  const smart = SMART_VIEWS.find((v) => v.id === view);
  const title = list?.name ?? smart?.label ?? "Tasks";
  const subtitle = view === "today" ? format(new Date(), "EEEE, d MMMM") : null;
  const readOnly = (t: Task) => !!listById.get(t.listId)?.readOnly;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-start gap-2 px-6 pt-5 pb-3">
        {!sidebarOpen && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground -ml-2 mt-0.5"
            onClick={() => useStore.getState().set({ sidebarOpen: true })}
            aria-label="Show sidebar"
          >
            <PanelLeftIcon />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-2xl font-semibold tracking-tight">
            {list && <span className="size-3 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />}
            <span className="truncate">{title}</span>
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {subtitle ? `${subtitle} · ` : ""}
            {openCount === 1 ? "1 task" : `${openCount} tasks`}
            {list?.readOnly ? " · read-only" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => useStore.getState().set({ search: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  useStore.getState().set({ search: "" });
                  e.currentTarget.blur();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.currentTarget.blur();
                  move(1);
                }
              }}
              placeholder="Search"
              className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 placeholder:text-muted-foreground h-8 w-44 rounded-md border bg-transparent pr-7 pl-8 text-sm outline-none transition-[width] focus-visible:w-60 focus-visible:ring-[3px]"
            />
            {search && (
              <button
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                onClick={() => useStore.getState().set({ search: "" })}
                aria-label="Clear search"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => useStore.getState().set({ showCompleted: !showCompleted })}
                aria-pressed={showCompleted}
                aria-label="Show completed tasks"
              >
                {showCompleted ? <EyeIcon /> : <EyeOffIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {showCompleted ? "Hide completed" : "Show completed"} <Kbd>Ctrl H</Kbd>
            </TooltipContent>
          </Tooltip>
          {list && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="List options">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  disabled={list.readOnly}
                  onSelect={() => useStore.getState().set({ listDialog: { mode: "edit", list } })}
                >
                  <PencilIcon /> Rename list…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={list.readOnly} onSelect={() => setConfirmDeleteList(true)}>
                  <Trash2Icon /> Delete list…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {!(list?.readOnly) && <QuickAdd />}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={listRef} role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
            {sections.map((section) => (
              <section key={section.id} className="mb-2">
                {section.title && (
                  <h2
                    className={cn(
                      "bg-background/95 sticky top-0 z-10 px-2 pt-3 pb-1.5 text-xs font-semibold tracking-wide uppercase backdrop-blur",
                      section.tone === "danger" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {section.title}
                    <span className="text-muted-foreground/70 ml-2 font-normal">{section.rows.length}</span>
                  </h2>
                )}
                {section.rows.map((r) => (
                  <TaskRow
                    key={r.task.id}
                    task={r.task}
                    depth={r.depth}
                    childCount={r.childCount}
                    childDone={r.childDone}
                    hasVisibleChildren={r.hasVisibleChildren}
                    collapsed={!!collapsed[r.task.uid]}
                    selected={r.task.id === selectedId}
                    list={listId ? null : (listById.get(r.task.listId) ?? null)}
                    readOnly={readOnly(r.task)}
                  />
                ))}
              </section>
            ))}
            {rows.length === 0 && <EmptyState view={view} searching={!!search} />}
          </div>
        </ContextMenuTrigger>
        {selected && <TaskMenu task={selected} readOnly={readOnly(selected)} onDelete={deleteSelected} />}
      </ContextMenu>

      <AlertDialog open={confirmDeleteList} onOpenChange={setConfirmDeleteList}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{list?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The list and all of its tasks are deleted from the server. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => list && void useStore.getState().deleteList(list.id)}
            >
              Delete list
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TaskMenu({ task, readOnly, onDelete }: { task: Task; readOnly: boolean; onDelete: () => void }) {
  const lists = useStore((s) => s.lists);
  const update = (patch: Parameters<ReturnType<typeof useStore.getState>["updateTask"]>[1]) =>
    void useStore.getState().updateTask(task.id, patch);
  const today = new Date();

  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem disabled={readOnly} onSelect={() => void useStore.getState().toggleComplete(task.id)}>
        {task.completed ? <CircleIcon /> : <CheckCircle2Icon />}
        {task.completed ? "Mark as not done" : "Mark as done"}
        <ContextMenuShortcut>Space</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 }))}>
        <PencilIcon /> Edit
        <ContextMenuShortcut>Enter</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={readOnly}>
          <CalendarIcon /> Due date
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          <ContextMenuItem onSelect={() => update({ due: dateOnly(today) })}>
            <SunIcon /> Today <ContextMenuShortcut>T</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => update({ due: dateOnly(addDays(today, 1)) })}>
            <CalendarIcon /> Tomorrow <ContextMenuShortcut>M</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => update({ due: dateOnly(nextMonday(today)) })}>
            <CalendarIcon /> Next week
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!task.due} onSelect={() => update({ due: null })}>
            <XIcon /> No due date
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={readOnly}>
          <FlagIcon /> Priority
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          {PRIORITIES.map((p, i) => (
            <ContextMenuItem key={p.level} onSelect={() => update({ priority: p.value })}>
              {p.value ? <PriorityFlag priority={p.value} className="size-4" /> : <FlagIcon />}
              {p.label}
              <ContextMenuShortcut>{i === 3 ? 0 : i + 1}</ContextMenuShortcut>
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={readOnly}>
          <ArrowRightLeftIcon /> Move to
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          {lists
            .filter((l) => !l.readOnly)
            .map((l) => (
              <ContextMenuItem
                key={l.id}
                disabled={l.id === task.listId}
                onSelect={() => void useStore.getState().moveTask(task.id, l.id)}
              >
                <span className="size-2.5 rounded-full" style={{ background: l.color ?? "var(--muted-foreground)" }} />
                <span className="truncate">{l.name}</span>
              </ContextMenuItem>
            ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem
        disabled={readOnly}
        onSelect={() =>
          void useStore.getState().createTask(task.listId, {
            summary: task.summary,
            description: task.description || null,
            priority: task.priority,
            due: task.due,
            categories: task.categories,
            parentUid: task.parentUid,
            rrule: task.rrule,
          })
        }
      >
        <CopyIcon /> Duplicate
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={readOnly} onSelect={onDelete}>
        <Trash2Icon /> Delete
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function EmptyState({ view, searching }: { view: string; searching: boolean }) {
  const text = searching
    ? { title: "No matching tasks", body: "Try a different search." }
    : view === "today"
      ? { title: "Nothing due today", body: "Enjoy the free time — or plan ahead in Upcoming." }
      : view === "upcoming"
        ? { title: "Nothing scheduled", body: "Tasks with a due date show up here." }
        : view === "important"
          ? { title: "No important tasks", body: "Tasks with high priority show up here." }
          : { title: "No tasks yet", body: "Add one above — press N anywhere to start typing." };
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-24 text-center">
      <div className="bg-muted mb-2 flex size-14 items-center justify-center rounded-full">
        {searching ? <SearchIcon className="size-6" /> : <CheckCircle2Icon className="size-6" />}
      </div>
      <p className="text-foreground font-medium">{text.title}</p>
      <p className="text-sm">{text.body}</p>
      {!searching && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => useStore.setState((s) => ({ focusQuickAdd: s.focusQuickAdd + 1 }))}
        >
          <PlusIcon /> New task
        </Button>
      )}
    </div>
  );
}
