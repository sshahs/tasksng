import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, format, nextMonday } from "date-fns";
import { AnimatePresence, m } from "motion/react";
import { toast } from "sonner";
import {
  ArrowRightLeftIcon,
  ArrowUpDownIcon,
  BookmarkPlusIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FlagIcon,
  HashIcon,
  HourglassIcon,
  MenuIcon,
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDayKey } from "@/hooks/use-day-key";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useBigChange, useJustCompleted } from "@/hooks/use-list-motion";
import { usePresence } from "@/hooks/use-presence";
import { isTouch, useIsMobile } from "@/hooks/use-mobile";
import { dateOnly } from "@/lib/dates";
import { planDrop, planKeyboardMove, useDrag, type DropPlan } from "@/lib/dnd";
import { FILTER_HELP } from "@/lib/search";
import { SORT_MODES } from "@/lib/sort";
import { listIdOf, searchIdOf, SMART_VIEWS, tagOf, useStore, type ViewId } from "@/lib/store";
import type { Task, TaskPatch } from "@/lib/types";
import { cn } from "@/lib/utils";
import { buildSections, type Row, type Section } from "@/lib/views";
import { FlipList, listItemProps } from "./animated-list";
import { PRIORITIES, PriorityFlag } from "./priority";
import { QuickAdd } from "./quick-add";
import { STATUSES } from "./status";
import { TaskRow } from "./task-row";

type Item = { key: string; section: Section; row?: Row };

/** Applies a drag-and-drop or keyboard move, switching the list to manual order if needed. */
function applyPlan(view: ViewId, plan: DropPlan) {
  const s = useStore.getState();
  if (plan.expand && s.collapsed[plan.expand]) s.toggleCollapsed(plan.expand);
  if (plan.reordered && s.sortFor(view) !== "manual") {
    s.setSort(view, "manual");
    toast("Sorted manually", { description: "Change the order any time with the sort button." });
  }
  void s.updateTasks(plan.updates);
}

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
  const savedSearches = useStore((s) => s.savedSearches);
  const sort = useStore((s) => s.sorts[s.view] ?? "smart");
  const dayKey = useDayKey();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [confirmDeleteList, setConfirmDeleteList] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // Phone layout: the search box opens in its own row.
  const mobile = useIsMobile();
  const [searchOpen, setSearchOpen] = useState(false);
  const showSearchRow = mobile && (searchOpen || !!search);

  const listId = listIdOf(view);
  const tag = tagOf(view);
  const saved = savedSearches.find((s) => s.id === searchIdOf(view)) ?? null;
  const list = listId ? (lists.find((l) => l.id === listId) ?? null) : null;
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const all = useMemo(() => Object.values(tasks), [tasks]);
  const keep = useJustCompleted(tasks);
  const conflicts = useStore((s) => s.conflicts);
  const conflictIds = useMemo(() => new Set(conflicts.map((c) => c.id)), [conflicts]);
  const sections = useMemo(
    () => buildSections(view, all, { search, showCompleted, collapsed, sort, lists, savedSearches, keep }),
    // dayKey re-evaluates "today" after midnight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, all, search, showCompleted, collapsed, sort, lists, savedSearches, keep, dayKey],
  );
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const items = useMemo<Item[]>(
    () =>
      sections.flatMap((section) => [
        ...(section.title ? [{ key: `section:${section.id}`, section }] : []),
        ...section.rows.map((row) => ({ key: row.task.id, section, row })),
      ]),
    [sections],
  );
  const instant = useBigChange(items.map((i) => i.key));
  const shown = usePresence(items, instant);
  // A row starting to leave changes the order too: the rows below glide up.
  const order = shown.map((p) => (p.leaving ? `${p.key}~` : p.key)).join("\n");
  const openRows = useMemo<Row[]>(() => (listId ? (sections.find((s) => s.id === "open")?.rows ?? []) : []), [sections, listId]);
  const openCount = rows.filter((r) => !r.task.completed).length;
  const selected = selectedId ? tasks[selectedId] : undefined;

  useEffect(() => {
    if (!focusSearch) return;
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
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

  const readOnly = (t: Task) => !!listById.get(t.listId)?.readOnly;

  const keyboardMove = (dir: "up" | "down" | "in" | "out") => {
    if (!selected || !listId || readOnly(selected)) return;
    const plan = planKeyboardMove(selected, dir, openRows, all);
    if (plan) applyPlan(view, plan);
  };

  const update = (patch: TaskPatch) => selected && void useStore.getState().updateTask(selected.id, patch);

  useHotkeys([
    { keys: "arrowdown", handler: () => move(1) },
    { keys: "j", handler: () => move(1) },
    { keys: "arrowup", handler: () => move(-1) },
    { keys: "k", handler: () => move(-1) },
    { keys: "alt+arrowup", handler: () => keyboardMove("up") },
    { keys: "alt+arrowdown", handler: () => keyboardMove("down") },
    { keys: "alt+arrowright", handler: () => keyboardMove("in") },
    { keys: "alt+arrowleft", handler: () => keyboardMove("out") },
    { keys: "home", handler: () => rows[0] && useStore.getState().select(rows[0].task.id) },
    { keys: "end", handler: () => rows.length && useStore.getState().select(rows[rows.length - 1].task.id) },
    { keys: "space", handler: () => selected && void useStore.getState().toggleComplete(selected.id) },
    { keys: "mod+enter", handler: () => selected && void useStore.getState().toggleComplete(selected.id) },
    {
      keys: "i",
      handler: () => selected && !selected.completed && update({ status: selected.status === "in-process" ? "needs-action" : "in-process" }),
    },
    { keys: "enter", handler: () => selected && useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 })) },
    { keys: "f2", handler: () => selected && useStore.setState((s) => ({ focusTitle: s.focusTitle + 1 })) },
    { keys: "delete", handler: deleteSelected },
    { keys: "1", handler: () => update({ priority: 1 }) },
    { keys: "2", handler: () => update({ priority: 5 }) },
    { keys: "3", handler: () => update({ priority: 9 }) },
    { keys: "0", handler: () => update({ priority: 0 }) },
    { keys: "t", handler: () => update({ due: dateOnly(new Date()) }) },
    { keys: "m", handler: () => update({ due: dateOnly(addDays(new Date(), 1)) }) },
    {
      keys: "escape",
      handler: () => {
        const s = useStore.getState();
        if (s.search) s.set({ search: "" });
        else s.select(null);
      },
    },
  ]);

  const onDrop = (e: React.DragEvent) => {
    const { id, over } = useDrag.getState();
    useDrag.setState({ id: null, over: null });
    if (!id || over?.kind !== "row") return;
    e.preventDefault();
    const dragged = tasks[id];
    const target = tasks[over.id];
    if (!dragged || !target) return;
    const plan = planDrop(dragged, target, over.pos, openRows, all, collapsed);
    if (plan) applyPlan(view, plan);
  };

  const searchBox = (
    <div className="relative">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <input
        ref={searchRef}
        value={search}
        onChange={(e) => useStore.getState().set({ search: e.target.value })}
        onFocus={() => setSearchFocused(true)}
        onBlur={() => setSearchFocused(false)}
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
        aria-label="Search or filter"
        className={cn(
          "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 placeholder:text-muted-foreground rounded-md border bg-transparent pr-7 pl-8 text-sm outline-none focus-visible:ring-[3px]",
          mobile ? "h-9 w-full" : "h-8 w-44 transition-[width] focus-visible:w-64",
        )}
      />
      {search && (
        <button
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          onClick={() => {
            useStore.getState().set({ search: "" });
            setSearchOpen(false);
          }}
          aria-label="Clear search"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
      {searchFocused && !search && (
        <div
          className={cn(
            "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 absolute right-0 z-30 origin-top-right rounded-md border p-3 text-xs shadow-md",
            mobile ? "top-11 w-full" : "top-10 w-72",
          )}
        >
          <p className="text-muted-foreground mb-2">Search words, or filter:</p>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {FILTER_HELP.map(([k, v]) => (
              <div key={k} className="contents">
                <code className="font-mono">{k}</code>
                <span className="text-muted-foreground">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const smart = SMART_VIEWS.find((v) => v.id === view);
  const title = list?.name ?? (tag !== null ? `#${tag}` : null) ?? saved?.name ?? smart?.label ?? "Tasks";
  const subtitle = view === "today" ? format(new Date(), "EEEE, d MMMM") : saved ? saved.query : null;
  const sortModes = SORT_MODES.filter((m) => !m.listsOnly || listId);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-start gap-2 px-6 pt-5 pb-3 max-md:px-4 max-md:pt-3">
        {mobile ? (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground -ml-2"
            onClick={() => useStore.getState().set({ drawerOpen: true })}
            aria-label="Lists"
          >
            <MenuIcon />
          </Button>
        ) : (
          !sidebarOpen && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground -ml-2 mt-0.5"
              onClick={() => useStore.getState().set({ sidebarOpen: true })}
              aria-label="Show sidebar"
            >
              <PanelLeftIcon />
            </Button>
          )
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-2xl font-semibold tracking-tight max-md:text-xl">
            {list && <span className="size-3 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />}
            {saved && <SearchIcon className="text-muted-foreground size-5 shrink-0" />}
            {/* A new view's name rises into place. */}
            <span key={view} className="animate-in fade-in-0 slide-in-from-bottom-1 truncate duration-300">
              {title}
            </span>
          </h1>
          <p className="text-muted-foreground mt-0.5 truncate text-sm">
            {subtitle ? `${subtitle} · ` : ""}
            {openCount === 1 ? "1 task" : `${openCount} tasks`}
            {list?.readOnly ? " · read-only" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {mobile ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground", showSearchRow && "text-foreground")}
              onClick={() => {
                if (showSearchRow) {
                  setSearchOpen(false);
                  useStore.getState().set({ search: "" });
                } else {
                  useStore.setState((x) => ({ focusSearch: x.focusSearch + 1 }));
                }
              }}
              aria-pressed={showSearchRow}
              aria-label="Search"
            >
              <SearchIcon />
            </Button>
          ) : (
            searchBox
          )}
          {search.trim() && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => useStore.getState().set({ searchDialog: { mode: "create", query: search } })}
                  aria-label="Save search"
                >
                  <BookmarkPlusIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Save this search in the sidebar</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className={cn("text-muted-foreground", sort !== "smart" && "text-foreground")} aria-label="Sort">
                    <ArrowUpDownIcon />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Sort</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => useStore.getState().setSort(view, v as never)}>
                {sortModes.map((m) => (
                  <DropdownMenuRadioItem key={m.value} value={m.value}>
                    {m.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
          {(list || saved || tag !== null) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More options">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {list && (
                  <>
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
                  </>
                )}
                {saved && (
                  <>
                    <DropdownMenuItem onSelect={() => useStore.getState().set({ searchDialog: { mode: "edit", search: saved } })}>
                      <PencilIcon /> Edit search…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => useStore.getState().deleteSavedSearch(saved.id)}>
                      <Trash2Icon /> Remove from sidebar
                    </DropdownMenuItem>
                  </>
                )}
                {tag !== null && <TagMenuItems tag={tag} />}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <AnimatePresence initial={false}>
        {showSearchRow && (
          <m.div
            key="search"
            className="px-4"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            style={{ overflow: "hidden" }}
          >
            <div className="pb-2">{searchBox}</div>
          </m.div>
        )}
      </AnimatePresence>

      {!list?.readOnly && <QuickAdd />}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            // A new view fades in as a whole; its rows don't animate one by one.
            key={view}
            ref={listRef}
            role="listbox"
            aria-label={title}
            className="animate-in fade-in-0 slide-in-from-bottom-1.5 relative min-h-0 flex-1 overflow-y-auto px-4 pb-8 duration-300 max-md:px-2"
            onDragOver={(e) => {
              // Dropping below the last task puts it at the end of the list.
              const { id, over } = useDrag.getState();
              if (!id || !listId || e.target !== e.currentTarget) return;
              const roots = openRows.filter((r) => r.depth === 0);
              const last = roots[roots.length - 1];
              if (!last || last.task.id === id || last.hasVisibleChildren) return;
              e.preventDefault();
              if (over?.kind !== "row" || over.id !== last.task.id || over.pos !== "after") {
                useDrag.setState({ over: { kind: "row", id: last.task.id, pos: "after" } });
              }
            }}
            onDrop={onDrop}
          >
            <FlipList container={listRef} order={order} disabled={instant}>
              {shown.map(({ key, item: { section, row: r }, entering, leaving }) => (
                <div
                  key={key}
                  {...listItemProps(key, entering, leaving, r ? undefined : "bg-background/95 sticky top-0 z-10 backdrop-blur")}
                >
                  {r ? (
                    <TaskRow
                      task={r.task}
                      depth={r.depth}
                      childCount={r.childCount}
                      childDone={r.childDone}
                      hasVisibleChildren={r.hasVisibleChildren}
                      collapsed={!!collapsed[r.task.uid]}
                      selected={!leaving && r.task.id === selectedId}
                      list={listId ? null : (listById.get(r.task.listId) ?? null)}
                      readOnly={readOnly(r.task)}
                      droppable={!leaving && !!listId && section.id === "open" && !readOnly(r.task)}
                      justDone={keep.has(r.task.id)}
                      conflict={conflictIds.has(r.task.id)}
                    />
                  ) : (
                    <h2
                      className={cn(
                        "mt-2 px-2 pt-3 pb-1.5 text-xs font-semibold tracking-wide uppercase",
                        section.tone === "danger" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {section.title}
                      <span className="text-muted-foreground/70 ml-2 font-normal tabular-nums">{section.rows.length}</span>
                    </h2>
                  )}
                </div>
              ))}
            </FlipList>
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

/** Rename / remove a tag on every task that has it. */
export function TagMenuItems({ tag, Item = DropdownMenuItem }: { tag: string; Item?: typeof DropdownMenuItem }) {
  return (
    <>
      <Item onSelect={() => useStore.getState().set({ tagDialog: tag })}>
        <PencilIcon /> Rename tag…
      </Item>
      <Item variant="destructive" onSelect={() => void useStore.getState().removeTag(tag)}>
        <HashIcon /> Remove tag from all tasks
      </Item>
    </>
  );
}

function TaskMenu({ task, readOnly, onDelete }: { task: Task; readOnly: boolean; onDelete: () => void }) {
  const lists = useStore((s) => s.lists);
  const update = (patch: TaskPatch) => void useStore.getState().updateTask(task.id, patch);
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
          <CircleDashedIcon /> Status
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          {STATUSES.map((s) => (
            <ContextMenuItem key={s.value} onSelect={() => update({ status: s.value })}>
              {s.icon} {s.label}
              {task.status === s.value ? (
                <CheckIcon className="ml-auto" />
              ) : s.value === "in-process" ? (
                <ContextMenuShortcut>I</ContextMenuShortcut>
              ) : null}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
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
          <HourglassIcon /> Start date
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          <ContextMenuItem onSelect={() => update({ start: dateOnly(addDays(today, 1)) })}>
            <CalendarIcon /> Tomorrow
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => update({ start: dateOnly(nextMonday(today)) })}>
            <CalendarIcon /> Next week
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!task.start} onSelect={() => update({ start: null })}>
            <XIcon /> No start date
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
            start: task.start,
            categories: task.categories,
            parentUid: task.parentUid,
            rrule: task.rrule,
            reminders: task.reminders,
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

function EmptyState({ view, searching }: { view: ViewId; searching: boolean }) {
  const text = searching
    ? { title: "No matching tasks", body: "Try a different search." }
    : view === "today"
      ? { title: "Nothing due today", body: "Enjoy the free time — or plan ahead in Upcoming." }
      : view === "upcoming"
        ? { title: "Nothing scheduled", body: "Tasks with a due date show up here." }
        : view === "important"
          ? { title: "No important tasks", body: "Tasks with high priority show up here." }
          : tagOf(view) !== null
            ? { title: "No open tasks with this tag", body: "Add one above and it gets the tag." }
            : searchIdOf(view)
              ? { title: "Nothing matches this search", body: "Tasks show up here as soon as they match." }
              : { title: "No tasks yet", body: isTouch() ? "Add one above." : "Add one above — press N anywhere to start typing." };
  return (
    <div className="text-muted-foreground animate-rise flex flex-col items-center justify-center gap-2 py-24 text-center">
      <div className="bg-muted animate-in zoom-in-50 fade-in-0 mb-2 flex size-14 items-center justify-center rounded-full delay-75 duration-500 ease-(--ease-pop) fill-mode-both">
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
