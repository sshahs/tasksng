import { useMemo } from "react";
import { m } from "motion/react";
import {
  AlarmClockIcon,
  CalendarDaysIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  FlameIcon,
  InboxIcon,
  MenuIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";

import { BentoGrid, BentoGridItem } from "@/components/aceternity/bento-grid";
import { GlowingEffect } from "@/components/aceternity/glowing-effect";
import { Button } from "@/components/ui/button";
import { useDayKey } from "@/hooks/use-day-key";
import { useIsMobile } from "@/hooks/use-mobile";
import { overview } from "@/lib/overview";
import { useStore, type ViewId } from "@/lib/store";
import { cn } from "@/lib/utils";

function Tile({
  className,
  title,
  description,
  header,
  icon,
  onClick,
}: {
  className?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  header?: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className={cn("relative rounded-xl", onClick && "cursor-pointer", className)} onClick={onClick}>
      <GlowingEffect spread={40} glow proximity={64} inactiveZone={0.01} borderWidth={2} disabled={false} />
      <BentoGridItem
        className="bg-card text-card-foreground border-border relative h-full dark:bg-card dark:border-border [&_div]:text-inherit"
        title={<span className="text-foreground">{title}</span>}
        description={<span className="text-muted-foreground">{description}</span>}
        header={header}
        icon={icon}
      />
    </div>
  );
}

function Big({ value, tone }: { value: number; tone?: string }) {
  return <div className={cn("text-4xl font-semibold tabular-nums tracking-tight", tone)}>{value}</div>;
}

/** How things stand: what is due, what got done, and how the last two weeks went. */
export function Overview() {
  const tasks = useStore((s) => s.tasks);
  const lists = useStore((s) => s.lists);
  const mobile = useIsMobile();
  const dayKey = useDayKey();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const o = useMemo(() => overview(Object.values(tasks), lists), [tasks, lists, dayKey]);
  const go = (v: ViewId) => useStore.getState().setView(v);
  const total = o.completedToday + o.dueToday + o.overdue;
  const fraction = total ? o.completedToday / total : 0;
  const max = Math.max(1, ...o.perDay.map((d) => d.count));
  const listMax = Math.max(1, ...o.byList.map((l) => l.count));
  const hour = new Date().getHours();

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {mobile && (
          <Button size="icon-sm" variant="ghost" aria-label="Lists" onClick={() => useStore.getState().set({ drawerOpen: true })}>
            <MenuIcon />
          </Button>
        )}
        <h1 className="font-semibold">Overview</h1>
      </header>
      <div className="p-4 md:p-6">
        <BentoGrid className="md:auto-rows-[12rem]">
          <Tile
            className="md:col-span-2"
            title={total === 0 ? "Nothing due today" : o.dueToday + o.overdue === 0 ? "Today is done" : `${o.dueToday + o.overdue} to go today`}
            description={`${o.completedToday} completed today · ${o.completedThisWeek} in the last 7 days`}
            icon={hour < 18 ? <SunIcon className="size-4 text-amber-500" /> : <MoonIcon className="size-4 text-indigo-400" />}
            onClick={() => go("today")}
            header={
              <div className="flex items-center gap-5">
                <svg viewBox="0 0 36 36" className="size-20 -rotate-90">
                  <circle cx="18" cy="18" r="15.5" fill="none" className="stroke-muted" strokeWidth="4" />
                  <m.circle
                    cx="18"
                    cy="18"
                    r="15.5"
                    fill="none"
                    className="stroke-primary"
                    strokeWidth="4"
                    strokeLinecap="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: fraction }}
                  />
                </svg>
                <div className="text-3xl font-semibold tabular-nums">{Math.round(fraction * 100)}%</div>
                {o.streak > 1 && (
                  <div className="ml-auto flex items-center gap-1 rounded-full bg-amber-500/10 px-3 py-1 text-sm text-amber-600 dark:text-amber-400">
                    <FlameIcon className="size-4" /> {o.streak} days in a row
                  </div>
                )}
              </div>
            }
          />
          <Tile
            title="Overdue"
            description="Due before today"
            icon={<AlarmClockIcon className="text-priority-high size-4" />}
            header={<Big value={o.overdue} tone={o.overdue ? "text-priority-high" : undefined} />}
            onClick={() => go("today")}
          />
          <Tile
            title="This week"
            description={`${o.dueToday} today, the rest over the next six days`}
            icon={<CalendarDaysIcon className="size-4 text-rose-500" />}
            header={<Big value={o.dueThisWeek} />}
            onClick={() => go("upcoming")}
          />
          <Tile
            className="md:col-span-2"
            title="Completed, last 14 days"
            description="Cancelled tasks don't count"
            icon={<CheckCircle2Icon className="size-4 text-emerald-500" />}
            header={
              <div className="flex h-24 items-end gap-1">
                {o.perDay.map((d) => (
                  <div key={d.day.toISOString()} className="flex flex-1 flex-col items-center gap-1" title={`${d.count} on ${d.day.toDateString()}`}>
                    <m.div
                      className={cn("w-full rounded-t", d.count ? "bg-primary" : "bg-muted")}
                      initial={{ height: 2 }}
                      animate={{ height: Math.max(d.count ? 4 : 2, (64 * d.count) / max) }}
                    />
                    <span className="text-muted-foreground text-[10px]">{d.label}</span>
                  </div>
                ))}
              </div>
            }
          />
          <Tile
            title="Open"
            description={`${o.snoozed} snoozed · ${o.unplanned} of today's not planned`}
            icon={<InboxIcon className="size-4 text-sky-500" />}
            header={<Big value={o.open} />}
            onClick={() => go("all")}
          />
          {o.byList.length > 0 && (
            <Tile
              className="md:col-span-3 md:row-span-1"
              title="Open tasks by list"
              icon={<CalendarClockIcon className="size-4 text-violet-500" />}
              header={
                <div className="grid max-h-28 gap-2 overflow-y-auto pr-1">
                  {o.byList.map(({ list, count }) => (
                    <button key={list.id} className="grid gap-1 text-left text-sm" onClick={() => go(`list:${list.id}`)}>
                      <div className="flex justify-between">
                        <span className="truncate">{list.name}</span>
                        <span className="text-muted-foreground tabular-nums">{count}</span>
                      </div>
                      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                        <m.div
                          className="h-full rounded-full"
                          style={{ backgroundColor: list.color ?? "var(--primary)" }}
                          initial={{ width: 0 }}
                          animate={{ width: `${(100 * count) / listMax}%` }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              }
            />
          )}
        </BentoGrid>
      </div>
    </div>
  );
}
