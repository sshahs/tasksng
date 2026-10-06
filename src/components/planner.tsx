import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, format, isSameDay, startOfDay } from "date-fns";
import { ChevronLeftIcon, ChevronRightIcon, CloudOffIcon, GripVerticalIcon, MapPinIcon, MenuIcon, PanelLeftIcon } from "lucide-react";
import { AnimatePresence, m } from "motion/react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api";
import { dateOnly, formatDue, parseDue } from "@/lib/dates";
import { fade, spring } from "@/lib/motion";
import {
  atMinutes,
  busyMinutes,
  dayRange,
  DEFAULT_MINUTES,
  formatMinutes,
  iso,
  layoutSlots,
  minutesInto,
  plannedTasks,
  snap,
  STEP,
  trayTasks,
} from "@/lib/planner";
import { useStore } from "@/lib/store";
import type { CalEvent, EventsResult, Task, TaskList } from "@/lib/types";
import { cn } from "@/lib/utils";
import { priorityBorder, priorityLevel } from "./priority";
import { QuickAdd } from "./quick-add";

/** One pixel per minute: the day is 1440 px tall. */
const PX = 1;
const GUTTER = 52;
/** The working day that "free time" is counted in. */
const DAY_END = 18 * 60;

// --------------------------------------------------------------------------
// Events

const cache = new Map<string, EventsResult>();

/** The calendar events of a day: cached ones at once, then fresh ones. */
function useEvents(day: Date) {
  const { from, to } = dayRange(day);
  const lastSync = useStore((s) => s.lastSync);
  const [result, setResult] = useState<EventsResult | null>(() => cache.get(from) ?? null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setResult(cache.get(from) ?? null);
    const load = () => {
      setLoading(true);
      api
        .getEvents(from, to)
        .then((r) => {
          cache.set(from, r);
          if (alive) setResult(r);
        })
        .catch((e) => {
          if (alive) setResult((prev) => ({ events: prev?.events ?? [], fetchedAt: prev?.fetchedAt ?? null, error: String(e) }));
        })
        .finally(() => alive && setLoading(false));
    };
    load();
    const every = window.setInterval(load, 5 * 60_000);
    const onFocus = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(every);
      window.removeEventListener("focus", onFocus);
    };
    // A sync may have brought calendar changes too.
  }, [from, to, lastSync]);
  return { events: result?.events ?? [], error: result?.error ?? null, loading };
}

/** Minutes since midnight, updated every minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

// --------------------------------------------------------------------------
// Dragging (pointer events: mouse, pen and touch alike)

interface Drag {
  taskId: string;
  /** Moving a block (or a task from the tray) or changing its length. */
  mode: "move" | "resize";
  from: "tray" | "timeline";
  duration: number;
  /** Where in the block the pointer took hold (minutes from its top). */
  grab: number;
  start: number;
  x: number;
  y: number;
  over: boolean;
  title: string;
}

interface Press {
  drag: Drag;
  startX: number;
  startY: number;
  active: boolean;
  timer: number | undefined;
  /** Has been well inside the timeline: only then do its edges scroll it. */
  armed: boolean;
}

/** How close to the timeline's top or bottom a held block scrolls it. */
const EDGE = 40;

/** Fingers have to hold still for a moment so that scrolling still works. */
const LONG_PRESS = 280;

// --------------------------------------------------------------------------

export function Planner() {
  const mobile = useIsMobile();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const tasksById = useStore((s) => s.tasks);
  const lists = useStore((s) => s.lists);
  const now = useNow();
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [direction, setDirection] = useState(0);
  const { events, error, loading } = useEvents(day);
  const isToday = isSameDay(day, now);
  const tasks = useMemo(() => Object.values(tasksById), [tasksById]);
  // Tasks taken off the plan stay in the tray, even when they aren't due that day.
  const [unplanned, setUnplanned] = useState<ReadonlySet<string>>(new Set());
  const tray = useMemo(() => {
    const base = trayTasks(tasks, day, now);
    const extra = tasks.filter((t) => unplanned.has(t.id) && !t.planned && !t.completed && !base.includes(t));
    return [...base, ...extra];
  }, [tasks, day, now, unplanned]);
  const planned = useMemo(() => plannedTasks(tasks, day), [tasks, day]);
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);

  const scroller = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<Press | null>(null);

  useHotkeys([
    { keys: "escape", handler: () => !press.current && useStore.getState().select(null) },
    { keys: "arrowleft", handler: () => go(-1) },
    { keys: "arrowright", handler: () => go(1) },
    { keys: "t", handler: () => go(0) },
  ]);

  const go = (days: number) => {
    setDirection(days);
    setDay((d) => (days === 0 ? startOfDay(new Date()) : addDays(d, days)));
  };

  // Open at the current time today, at 8:00 on other days.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const at = isToday ? minutesInto(day, new Date()) - 90 : 8 * 60;
    el.scrollTop = Math.max(0, at * PX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  /** Minute of the day under the pointer, or null when it isn't over the timeline. */
  const minuteAt = useCallback((x: number, y: number): number | null => {
    const el = scroller.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    return (y - r.top + el.scrollTop) / PX;
  }, []);

  const update = useCallback(
    (x: number, y: number) => {
      const p = press.current;
      if (!p) return;
      const d = p.drag;
      const minute = minuteAt(x, y);
      const r = scroller.current?.getBoundingClientRect();
      if (minute !== null && r && y > r.top + EDGE && y < r.bottom - EDGE) p.armed = true;
      const next: Drag = { ...d, x, y, over: minute !== null };
      if (minute !== null) {
        if (d.mode === "move") next.start = snap(minute - d.grab, d.duration);
        else next.duration = Math.max(STEP, snap(minute) - d.start);
      }
      p.drag = next;
      setDrag(next);
    },
    [minuteAt],
  );

  // Scroll the timeline while a block is held near its top or bottom edge.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const el = scroller.current;
      const p = press.current;
      if (el && p?.active && p.armed) {
        const r = el.getBoundingClientRect();
        const { x, y } = p.drag;
        const speed = y < r.top + EDGE ? -(r.top + EDGE - y) / 4 : y > r.bottom - EDGE ? (y - (r.bottom - EDGE)) / 4 : 0;
        if (speed && x >= r.left && x <= r.right) {
          el.scrollTop += speed;
          update(x, y);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging, update]);

  const finish = useCallback(
    (cancelled: boolean) => {
      const p = press.current;
      press.current = null;
      setDrag(null);
      if (!p) return;
      window.clearTimeout(p.timer);
      const d = p.drag;
      if (!p.active) {
        // Just a tap or click: show the task.
        if (!cancelled) useStore.getState().openDetail(d.taskId);
        return;
      }
      if (cancelled) return;
      const task = useStore.getState().tasks[d.taskId];
      if (!task) return;
      if (d.over) {
        const planned = iso(atMinutes(day, d.start));
        if (planned !== task.planned || d.duration !== (task.plannedMinutes ?? DEFAULT_MINUTES)) {
          void useStore.getState().updateTask(task.id, { planned, plannedMinutes: d.duration });
        }
      } else if (d.from === "timeline" && d.mode === "move") {
        // Dropped outside the timeline: back to the tray.
        setUnplanned((u) => new Set(u).add(task.id));
        void useStore.getState().updateTask(task.id, { planned: null });
      }
    },
    [day],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.active) {
        const dist = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
        if (e.pointerType === "mouse" && dist > 4) {
          p.active = true;
        } else if (e.pointerType !== "mouse" && dist > 8) {
          // A finger moving before the long press: that's scrolling.
          window.clearTimeout(p.timer);
          press.current = null;
          return;
        } else {
          return;
        }
      }
      update(e.clientX, e.clientY);
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const key = (e: KeyboardEvent) => e.key === "Escape" && finish(true);
    // While dragging with a finger the page must not scroll.
    const touch = (e: TouchEvent) => press.current?.active && e.preventDefault();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("touchmove", touch, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("touchmove", touch);
    };
  }, [update, finish]);

  /** Starts a possible drag; it begins after a small move (mouse) or a long press (touch). */
  const begin = (e: React.PointerEvent, task: Task, mode: Drag["mode"], from: Drag["from"]) => {
    if (e.button !== 0) return;
    const start = task.planned ? minutesInto(day, new Date(task.planned)) : 9 * 60;
    const duration = task.plannedMinutes ?? DEFAULT_MINUTES;
    const minute = minuteAt(e.clientX, e.clientY);
    const grab = from === "timeline" && minute !== null ? Math.max(0, Math.min(duration, minute - start)) : Math.min(duration, STEP);
    const p: Press = {
      drag: { taskId: task.id, mode, from, duration, grab, start, x: e.clientX, y: e.clientY, over: from === "timeline", title: task.summary },
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: undefined,
      armed: from === "timeline",
    };
    if (e.pointerType !== "mouse") {
      p.timer = window.setTimeout(() => {
        if (press.current !== p) return;
        p.active = true;
        navigator.vibrate?.(8);
        update(p.drag.x, p.drag.y);
      }, LONG_PRESS);
    }
    press.current = p;
    if (mode === "resize") {
      e.stopPropagation();
      p.active = true;
      setDrag(p.drag);
    }
  };

  // ------------------------------------------------------------------------
  // Layout of the day

  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);
  const placed = planned.map((t) => {
    const dragged = drag?.taskId === t.id && drag.from === "timeline" && (drag.over || drag.mode === "resize");
    const start = dragged ? drag.start : minutesInto(day, new Date(t.planned!));
    const duration = dragged ? drag.duration : (t.plannedMinutes ?? DEFAULT_MINUTES);
    return { task: t, start, duration, dragged };
  });
  const ghost =
    drag && drag.over && drag.from === "tray" ? { start: drag.start, duration: drag.duration, title: drag.title } : null;
  const slots = [
    ...timed.map((e) => ({ id: e.id, start: minutesInto(day, new Date(e.start)), end: minutesInto(day, new Date(e.end)) })),
    ...placed.filter((p) => !p.dragged).map((p) => ({ id: p.task.id, start: p.start, end: p.start + p.duration })),
  ];
  const columns = layoutSlots(slots);

  const plannedTotal = placed.filter((p) => !p.task.completed).reduce((n, p) => n + p.duration, 0);
  const freeFrom = isToday ? Math.max(minutesInto(day, now), 8 * 60) : 8 * 60;
  const free = freeFrom < DAY_END ? DAY_END - freeFrom - busyMinutes(day, events, planned, freeFrom, DAY_END) : 0;

  const header = (
    <header className="flex items-start gap-2 px-6 pt-5 pb-3 max-md:px-4 max-md:pt-3">
      {mobile ? (
        <Button variant="ghost" size="icon" className="text-muted-foreground -ml-2" onClick={() => useStore.getState().set({ drawerOpen: true })} aria-label="Lists">
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
        <h1 className="truncate text-2xl font-semibold tracking-tight max-md:text-xl">
          <span key={day.toDateString()} className="animate-in fade-in-0 slide-in-from-bottom-1 inline-block duration-300">
            {isToday ? "Today" : format(day, "EEEE")}
          </span>
        </h1>
        <p className="text-muted-foreground mt-0.5 truncate text-sm">
          {format(day, "d MMMM")}
          {plannedTotal > 0 && ` · ${formatMinutes(plannedTotal)} planned`}
          {free > 0 && ` · ${formatMinutes(free)} free until 18:00`}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {error && (
          <span className="text-muted-foreground mr-1 flex items-center gap-1 text-xs" title={error}>
            <CloudOffIcon className="size-3.5" /> {events.length ? "Saved events" : "No events"}
          </span>
        )}
        {loading && !error && <span className="bg-primary/60 mr-2 size-1.5 animate-pulse rounded-full" aria-label="Loading events" />}
        {!isToday && (
          <Button variant="outline" size="sm" onClick={() => go(0)}>
            Today
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={() => go(-1)} aria-label="Previous day">
          <ChevronLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => go(1)} aria-label="Next day">
          <ChevronRightIcon />
        </Button>
      </div>
    </header>
  );

  const trayItems = (
    <AnimatePresence initial={false}>
      {tray.map((t) => (
        <m.div
          key={t.id}
          layout="position"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className={cn("shrink-0 overflow-hidden", mobile && "w-56")}
        >
          <TrayItem task={t} list={listById.get(t.listId)} lifted={drag?.taskId === t.id} onPointerDown={(e) => begin(e, t, "move", "tray")} />
        </m.div>
      ))}
    </AnimatePresence>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {header}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        {/* Tasks waiting for a time. Dropping a planned block here unplans it. */}
        <div
          ref={trayRef}
          className={cn(
            "flex shrink-0 flex-col transition-colors",
            mobile ? "border-b pb-2" : "w-72 border-r",
            drag?.from === "timeline" && !drag.over && drag.mode === "move" && "bg-primary/5",
          )}
        >
          <QuickAdd dueOn={dateOnly(day)} className="max-md:pb-2" />
          {mobile ? (
            <div className="flex touch-pan-x gap-2 overflow-x-auto px-4">
              {trayItems}
              {tray.length === 0 && <p className="text-muted-foreground py-2 text-sm">Nothing left to plan.</p>}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              <p className="text-muted-foreground px-1 pt-1 pb-2 text-xs font-semibold tracking-wide uppercase">
                To plan <span className="text-muted-foreground/70 ml-1 font-normal tabular-nums">{tray.length}</span>
              </p>
              <div className="grid gap-1.5">{trayItems}</div>
              {tray.length === 0 && (
                <p className="text-muted-foreground animate-in fade-in-0 px-1 py-6 text-center text-sm">
                  Nothing left to plan. Drag a block here to unplan it.
                </p>
              )}
              {tray.length > 0 && (
                <p className="text-muted-foreground/80 px-1 pt-3 text-xs">Drag a task onto the timeline to plan it.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {allDay.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b px-4 py-2" style={{ paddingLeft: GUTTER + 4 }}>
              {allDay.map((e) => (
                <span
                  key={e.id}
                  className="animate-in fade-in-0 zoom-in-95 truncate rounded-md px-2 py-0.5 text-xs font-medium"
                  style={eventStyle(e.color)}
                  title={e.title}
                >
                  {e.title}
                </span>
              ))}
            </div>
          )}
          <div ref={scroller} className="relative min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain">
            <AnimatePresence initial={false} custom={direction} mode="popLayout">
              <m.div
                key={day.toDateString()}
                custom={direction}
                variants={{
                  enter: (d: number) => ({ x: d * 40, opacity: 0 }),
                  center: { x: 0, opacity: 1 },
                  exit: (d: number) => ({ x: d * -40, opacity: 0 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ x: spring, opacity: fade }}
                className="relative"
                style={{ height: 24 * 60 * PX }}
              >
                <Hours />
                {isToday && <NowLine minutes={minutesInto(day, now)} />}
                <div className="absolute inset-y-0 right-2" style={{ left: GUTTER }}>
                  {timed.map((e) => {
                    const start = minutesInto(day, new Date(e.start));
                    const end = minutesInto(day, new Date(e.end));
                    return (
                      <Block key={e.id} start={start} duration={end - start} place={columns.get(e.id)}>
                        <EventCard event={e} />
                      </Block>
                    );
                  })}
                  {placed.map(({ task, start, duration, dragged }) => (
                    <Block key={task.id} start={start} duration={duration} place={dragged ? undefined : columns.get(task.id)} lifted={dragged}>
                      <TaskCard
                        task={task}
                        list={listById.get(task.listId)}
                        start={start}
                        duration={duration}
                        onPointerDown={(e) => begin(e, task, "move", "timeline")}
                        onResize={(e) => begin(e, task, "resize", "timeline")}
                      />
                    </Block>
                  ))}
                  {ghost && (
                    <Block start={ghost.start} duration={ghost.duration} lifted>
                      <div
                        className={cn(
                          "border-primary bg-primary/15 text-primary flex h-full min-w-0 gap-x-1.5 overflow-hidden rounded-md border-2 border-dashed px-2 py-0.5 text-xs font-medium",
                          ghost.duration < 45 ? "items-center" : "flex-col",
                        )}
                      >
                        <span className="truncate">{ghost.title || "Untitled task"}</span>
                        <span className="shrink-0 opacity-80 tabular-nums">{timeRange(day, ghost.start, ghost.duration)}</span>
                      </div>
                    </Block>
                  )}
                </div>
              </m.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* The task under the finger or pointer while it's away from the timeline. */}
      {drag && !drag.over && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none fixed z-50 max-w-60 truncate rounded-md border px-3 py-1.5 text-sm shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 8 }}
        >
          {drag.title || "Untitled task"}
        </div>
      )}
    </div>
  );
}

function eventStyle(color: string | null): React.CSSProperties {
  const c = color ?? "var(--muted-foreground)";
  return {
    background: `color-mix(in oklab, ${c} 16%, var(--background))`,
    borderLeft: `3px solid ${c}`,
    color: `color-mix(in oklab, ${c} 55%, var(--foreground))`,
  };
}

function timeRange(day: Date, start: number, duration: number): string {
  return `${format(atMinutes(day, start), "HH:mm")}–${format(atMinutes(day, start + duration), "HH:mm")}`;
}

function Hours() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="absolute right-0 left-0 border-t border-dashed first:border-transparent" style={{ top: h * 60 * PX }}>
          <span className="text-muted-foreground bg-background absolute -top-2 left-2 px-1 text-[11px] tabular-nums">
            {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
          </span>
        </div>
      ))}
    </div>
  );
}

function NowLine({ minutes }: { minutes: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-0 z-20 transition-[top] duration-1000 ease-linear"
      style={{ top: minutes * PX, left: GUTTER - 6 }}
    >
      <div className="bg-destructive h-0.5 w-full" />
      <span className="bg-destructive absolute -top-[4px] -left-[2px] size-2.5 rounded-full">
        <span className="bg-destructive absolute inset-0 animate-ping rounded-full opacity-40" />
      </span>
    </div>
  );
}

/** Places a block in the timeline; blocks that overlap share the width. */
function Block({
  start,
  duration,
  place,
  lifted = false,
  children,
}: {
  start: number;
  duration: number;
  place?: { col: number; cols: number };
  lifted?: boolean;
  children: React.ReactNode;
}) {
  const cols = place?.cols ?? 1;
  const col = place?.col ?? 0;
  return (
    <div
      className={cn(
        "absolute px-0.5",
        lifted ? "z-30 transition-[top,height] duration-75" : "z-10 transition-[top,height,left,width] duration-300",
      )}
      style={{
        top: start * PX,
        height: Math.max(duration, STEP) * PX,
        left: `${(col / cols) * 100}%`,
        width: `${100 / cols}%`,
      }}
    >
      {children}
    </div>
  );
}

function EventCard({ event }: { event: CalEvent }) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const short = (end.getTime() - start.getTime()) / 60_000 < 45;
  return (
    <div
      className="animate-in fade-in-0 zoom-in-95 h-full overflow-hidden rounded-md px-2 py-1 text-xs duration-300"
      style={eventStyle(event.color)}
      title={`${event.title}\n${format(start, "HH:mm")}–${format(end, "HH:mm")}${event.location ? `\n${event.location}` : ""}`}
    >
      <div className={cn("flex min-w-0 gap-1.5", short ? "items-center" : "flex-col gap-0")}>
        <span className="truncate font-medium">{event.title}</span>
        <span className="shrink-0 opacity-80 tabular-nums">
          {format(start, "HH:mm")}
          {!short && `–${format(end, "HH:mm")}`}
        </span>
        {!short && event.location && (
          <span className="flex min-w-0 items-center gap-1 opacity-80">
            <MapPinIcon className="size-3 shrink-0" />
            <span className="truncate">{event.location}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  list,
  start,
  duration,
  onPointerDown,
  onResize,
}: {
  task: Task;
  list: TaskList | undefined;
  start: number;
  duration: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onResize: (e: React.PointerEvent) => void;
}) {
  const selected = useStore((s) => s.selectedId === task.id);
  const day = new Date(task.planned!);
  const short = duration < 45;
  const color = list?.color ?? "var(--primary)";
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => e.key === "Enter" && useStore.getState().openDetail(task.id)}
      className={cn(
        "group animate-in fade-in-0 zoom-in-95 relative flex h-full cursor-grab touch-pan-y gap-2 overflow-hidden rounded-md border px-2 py-1 text-xs shadow-sm duration-300 select-none active:cursor-grabbing",
        "bg-background hover:shadow-md",
        selected && "ring-primary ring-2",
        task.completed && "opacity-60",
      )}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Checkbox
        checked={task.completed}
        onPointerDown={(e) => e.stopPropagation()}
        onCheckedChange={() => void useStore.getState().toggleComplete(task.id)}
        aria-label={task.completed ? "Mark as not done" : "Mark as done"}
        className={cn("mt-px size-3.5 rounded-full border-[1.5px] shadow-none", priorityBorder[priorityLevel(task.priority)])}
      />
      <div className={cn("min-w-0 flex-1", short && "flex items-center gap-1.5")}>
        <div className={cn("truncate font-medium", task.completed && "text-muted-foreground")}>
          <span className={cn("strike")} data-done={task.completed}>
            {task.summary || "Untitled task"}
          </span>
        </div>
        <div className="text-muted-foreground shrink-0 tabular-nums">{timeRange(startOfDay(day), start, duration)}</div>
      </div>
      {/* Drag the bottom edge to change the length. */}
      <div
        onPointerDown={onResize}
        className="absolute inset-x-0 bottom-0 flex h-2 cursor-ns-resize touch-none justify-center opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      >
        <span className="bg-muted-foreground/50 mt-0.5 h-1 w-6 rounded-full" />
      </div>
    </div>
  );
}

function TrayItem({
  task,
  list,
  lifted,
  onPointerDown,
}: {
  task: Task;
  list: TaskList | undefined;
  lifted: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const due = parseDue(task.due);
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => e.key === "Enter" && useStore.getState().openDetail(task.id)}
      className={cn(
        "group bg-background flex cursor-grab touch-pan-y items-start gap-2 rounded-md border px-2.5 py-2 text-sm shadow-xs transition-[box-shadow,opacity,scale] select-none hover:shadow-md active:cursor-grabbing",
        lifted && "scale-[0.98] opacity-40",
      )}
    >
      <Checkbox
        checked={task.completed}
        onPointerDown={(e) => e.stopPropagation()}
        onCheckedChange={() => void useStore.getState().toggleComplete(task.id)}
        aria-label="Mark as done"
        className={cn("mt-0.5 size-4 rounded-full border-[1.5px] shadow-none", priorityBorder[priorityLevel(task.priority)])}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate leading-5">{task.summary || "Untitled task"}</div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          {list && (
            <span className="flex min-w-0 items-center gap-1">
              <span className="size-2 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />
              <span className="truncate">{list.name}</span>
            </span>
          )}
          {due && <span className="shrink-0">{formatDue(due)}</span>}
          {task.plannedMinutes && <span className="shrink-0">{formatMinutes(task.plannedMinutes)}</span>}
        </div>
      </div>
      <GripVerticalIcon className="text-muted-foreground/50 mt-0.5 size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}
