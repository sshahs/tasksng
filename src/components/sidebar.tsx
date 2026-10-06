import { useMemo, useState } from "react";
import {
  ArrowUpCircleIcon,
  CalendarDaysIcon,
  ChevronRightIcon,
  FlagIcon,
  HashIcon,
  InboxIcon,
  PanelLeftIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import { AnimatePresence, m, type PanInfo } from "motion/react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDayKey } from "@/hooks/use-day-key";
import { dateOnly, parseDue, toDue } from "@/lib/dates";
import { useDrag, type DropTarget } from "@/lib/dnd";
import { fade, snappy, spring } from "@/lib/motion";
import { getPref, setPref } from "@/lib/prefs";
import { startsLater } from "@/lib/search";
import { SMART_VIEWS, useStore, type SmartView, type ViewId } from "@/lib/store";
import { useUpdates } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { countOpen, tagCounts } from "@/lib/views";
import { SyncIndicator } from "./sync-indicator";

const ICONS: Record<SmartView, React.ReactNode> = {
  today: <SunIcon className="text-amber-500" />,
  upcoming: <CalendarDaysIcon className="text-rose-500" />,
  important: <FlagIcon className="text-priority-high" />,
  all: <InboxIcon className="text-sky-500" />,
};

const sameTarget = (a: DropTarget | null, b: DropTarget) => JSON.stringify(a) === JSON.stringify(b);

/** What dropping a task on a sidebar entry does. */
function dropOn(target: DropTarget, id: string) {
  const s = useStore.getState();
  const t = s.tasks[id];
  if (!t) return;
  switch (target.kind) {
    case "list":
      if (t.listId !== target.id) void s.moveTask(id, target.id);
      break;
    case "view":
      if (target.id === "important") void s.updateTask(id, { priority: 1 });
      else {
        // Keep the time of day if the task had one.
        const due = parseDue(t.due);
        const time = due?.hasTime ? `${due.date.getHours()}:${due.date.getMinutes()}` : null;
        void s.updateTask(id, { due: time ? toDue(new Date(), time) : dateOnly(new Date()) });
      }
      break;
    case "tag":
      if (!t.categories.some((c) => c.toLowerCase() === target.tag.toLowerCase())) {
        void s.updateTask(id, { categories: [...t.categories, target.tag] });
      }
      break;
    default:
      break;
  }
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  shortcut,
  drop,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  shortcut?: string;
  drop?: DropTarget;
}) {
  const over = useDrag((s) => !!drop && sameTarget(s.over, drop));
  return (
    <button
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      onDragOver={(e) => {
        if (!drop || !useDrag.getState().id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!sameTarget(useDrag.getState().over, drop)) useDrag.setState({ over: drop });
      }}
      onDragLeave={() => {
        if (drop && sameTarget(useDrag.getState().over, drop)) useDrag.setState({ over: null });
      }}
      onDrop={(e) => {
        const id = useDrag.getState().id;
        useDrag.setState({ id: null, over: null });
        if (!drop || !id) return;
        e.preventDefault();
        dropOn(drop, id);
      }}
      className={cn(
        "relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors max-md:h-10 [&_svg]:size-4 [&_svg]:shrink-0",
        "hover:bg-sidebar-accent/70 text-sidebar-foreground/85 active:scale-[0.98]",
        active && "text-sidebar-accent-foreground hover:bg-transparent font-medium",
        over && "bg-primary/15 ring-primary/60 ring-2 ring-inset",
      )}
    >
      {/* The highlight slides from the old view to the new one. */}
      {active && <m.span layoutId="nav-active" transition={snappy} className="bg-sidebar-accent absolute inset-0 rounded-md" />}
      <span className="relative flex shrink-0">{icon}</span>
      <span className="relative min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && (
        <span
          key={count}
          className="text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-1 relative text-xs tabular-nums duration-300"
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open?: boolean;
  onToggle?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="text-muted-foreground group mt-5 mb-1 flex items-center px-2 text-xs font-medium tracking-wide uppercase">
      <button className="flex flex-1 items-center gap-1 text-left uppercase" onClick={onToggle} disabled={!onToggle}>
        {label}
        {onToggle && (
          <ChevronRightIcon className={cn("size-3 opacity-0 transition group-hover:opacity-100", open && "rotate-90")} />
        )}
      </button>
      {action}
    </div>
  );
}

/** The sidebar sliding in over the tasks (phone layout). */
export function SidebarDrawer() {
  const open = useStore((s) => s.drawerOpen);
  const close = () => useStore.getState().set({ drawerOpen: false });
  // Swiping it back to the left closes it, like the system's own drawers.
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -80 || info.velocity.x < -400) close();
  };
  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            key="backdrop"
            aria-hidden
            className="fixed inset-0 z-40 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            onClick={close}
          />
          <m.div
            key="drawer"
            className="fixed inset-y-0 left-0 z-40 flex w-[min(20rem,85vw)] shadow-xl"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={spring}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 1, right: 0 }}
            dragMomentum={false}
            onDragEnd={onDragEnd}
          >
            <Sidebar drawer />
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function Sidebar({ drawer = false }: { drawer?: boolean }) {
  const view = useStore((s) => s.view);
  const lists = useStore((s) => s.lists);
  const tasks = useStore((s) => s.tasks);
  const account = useStore((s) => s.account);
  const savedSearches = useStore((s) => s.savedSearches);
  const update = useUpdates((s) => (s.phase === "ready" || s.phase === "installing" ? s.version : null));
  const dayKey = useDayKey();
  const all = useMemo(() => Object.values(tasks), [tasks]);
  const [tagsOpen, setTagsOpen] = useState(() => getPref("sidebar-tags", true));

  const counts = useMemo(() => {
    const now = new Date();
    const m = new Map<ViewId, number>();
    for (const v of SMART_VIEWS) m.set(v.id, countOpen(v.id, all, now));
    for (const s of savedSearches) m.set(`search:${s.id}`, countOpen(`search:${s.id}`, all, now, { lists, savedSearches }));
    const perList = new Map<string, number>();
    for (const t of all) if (!t.completed && !startsLater(t, now)) perList.set(t.listId, (perList.get(t.listId) ?? 0) + 1);
    return { views: m, perList, tags: tagCounts(all) };
    // dayKey forces recounting "Today" after midnight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, dayKey, savedSearches, lists]);

  const setView = (v: ViewId) => useStore.getState().setView(v);

  return (
    <nav
      className={cn("bg-sidebar border-sidebar-border flex h-full shrink-0 flex-col border-r", drawer ? "w-full" : "w-60")}
      aria-label="Lists"
    >
      <div className="flex h-12 items-center gap-2 px-4">
        <img src="/icon.svg" alt="" className="size-5" />
        <span className="font-semibold tracking-tight">TasksNG</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => useStore.getState().set(drawer ? { drawerOpen: false } : { sidebarOpen: false })}
              aria-label={drawer ? "Close" : "Hide sidebar"}
            >
              <PanelLeftIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{drawer ? "Close" : "Hide sidebar (Ctrl+B)"}</TooltipContent>
        </Tooltip>
      </div>

      {/* Vertical scrolling only: a sideways swipe closes the drawer on phones. */}
      <m.div layoutScroll className="min-h-0 flex-1 touch-pan-y overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {SMART_VIEWS.map((v, i) => (
            <NavItem
              key={v.id}
              active={view === v.id}
              onClick={() => setView(v.id)}
              icon={ICONS[v.id]}
              label={v.label}
              count={counts.views.get(v.id) ?? 0}
              shortcut={`Ctrl+${i + 1}`}
              drop={v.id === "today" || v.id === "important" ? { kind: "view", id: v.id } : undefined}
            />
          ))}
        </div>

        <SectionHeader
          label="Lists"
          action={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground -mr-1"
                  onClick={() => useStore.getState().set({ listDialog: { mode: "create" } })}
                  aria-label="New list"
                >
                  <PlusIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New list</TooltipContent>
            </Tooltip>
          }
        />
        <div className="space-y-0.5">
          {lists.map((l, i) => (
            <ContextMenu key={l.id}>
              <ContextMenuTrigger asChild>
                <div>
                  <NavItem
                    active={view === `list:${l.id}`}
                    onClick={() => setView(`list:${l.id}`)}
                    icon={<span className="m-[3px] size-2.5 rounded-full" style={{ background: l.color ?? "var(--muted-foreground)" }} />}
                    label={l.name}
                    count={counts.perList.get(l.id) ?? 0}
                    shortcut={i + SMART_VIEWS.length < 9 ? `Ctrl+${i + SMART_VIEWS.length + 1}` : undefined}
                    drop={l.readOnly ? undefined : { kind: "list", id: l.id }}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  disabled={l.readOnly}
                  onSelect={() => useStore.getState().set({ listDialog: { mode: "edit", list: l } })}
                >
                  <PencilIcon /> Rename…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
          {lists.length === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-xs">No task lists on the server yet.</p>
          )}
        </div>

        {savedSearches.length > 0 && (
          <>
            <SectionHeader label="Saved searches" />
            <div className="space-y-0.5">
              {savedSearches.map((s) => (
                <ContextMenu key={s.id}>
                  <ContextMenuTrigger asChild>
                    <div>
                      <NavItem
                        active={view === `search:${s.id}`}
                        onClick={() => setView(`search:${s.id}`)}
                        icon={<SearchIcon className="text-muted-foreground" />}
                        label={s.name}
                        count={counts.views.get(`search:${s.id}`) ?? 0}
                      />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => useStore.getState().set({ searchDialog: { mode: "edit", search: s } })}>
                      <PencilIcon /> Edit…
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onSelect={() => useStore.getState().deleteSavedSearch(s.id)}>
                      <Trash2Icon /> Remove
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          </>
        )}

        {counts.tags.length > 0 && (
          <>
            <SectionHeader
              label="Tags"
              open={tagsOpen}
              onToggle={() => {
                setPref("sidebar-tags", !tagsOpen);
                setTagsOpen(!tagsOpen);
              }}
            />
            <AnimatePresence initial={false}>
              {tagsOpen && (
                <m.div
                  className="space-y-0.5 overflow-hidden"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={spring}
                >
                  {counts.tags.map(({ tag, count }) => (
                    <ContextMenu key={tag}>
                      <ContextMenuTrigger asChild>
                        <div>
                          <NavItem
                            active={view.toLowerCase() === `tag:${tag.toLowerCase()}`}
                            onClick={() => setView(`tag:${tag}`)}
                            icon={<HashIcon className="text-muted-foreground" />}
                            label={tag}
                            count={count}
                            drop={{ kind: "tag", tag }}
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => useStore.getState().set({ tagDialog: tag })}>
                          <PencilIcon /> Rename tag…
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onSelect={() => void useStore.getState().removeTag(tag)}>
                          <Trash2Icon /> Remove from all tasks
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </m.div>
              )}
            </AnimatePresence>
          </>
        )}
      </m.div>

      <div className="border-sidebar-border flex items-center gap-1 border-t p-2">
        <SyncIndicator />
        {update && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-primary shrink-0"
                onClick={() => void useUpdates.getState().install()}
                aria-label={`Restart to update to ${update}`}
              >
                <ArrowUpCircleIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Restart to update to {update}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              onClick={() => useStore.getState().set({ settingsOpen: true })}
              aria-label="Settings"
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{account ? `${account.username} · Settings` : "Settings"}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
