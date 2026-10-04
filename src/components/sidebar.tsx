import { useMemo } from "react";
import {
  CalendarDaysIcon,
  FlagIcon,
  InboxIcon,
  PanelLeftIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDayKey } from "@/hooks/use-day-key";
import { SMART_VIEWS, useStore, type SmartView, type ViewId } from "@/lib/store";
import { cn } from "@/lib/utils";
import { countOpen } from "@/lib/views";
import { SyncIndicator } from "./sync-indicator";

const ICONS: Record<SmartView, React.ReactNode> = {
  today: <SunIcon className="text-amber-500" />,
  upcoming: <CalendarDaysIcon className="text-rose-500" />,
  important: <FlagIcon className="text-priority-high" />,
  all: <InboxIcon className="text-sky-500" />,
};

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  shortcut,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  shortcut?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
        "hover:bg-sidebar-accent text-sidebar-foreground/85",
        active && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && <span className="text-muted-foreground text-xs tabular-nums">{count}</span>}
    </button>
  );
}

export function Sidebar() {
  const view = useStore((s) => s.view);
  const lists = useStore((s) => s.lists);
  const tasks = useStore((s) => s.tasks);
  const account = useStore((s) => s.account);
  const dayKey = useDayKey();
  const all = useMemo(() => Object.values(tasks), [tasks]);

  const counts = useMemo(() => {
    const m = new Map<ViewId, number>();
    for (const v of SMART_VIEWS) m.set(v.id, countOpen(v.id, all));
    const perList = new Map<string, number>();
    for (const t of all) if (!t.completed) perList.set(t.listId, (perList.get(t.listId) ?? 0) + 1);
    return { smart: m, perList };
    // dayKey forces recounting "Today" after midnight.
  }, [all, dayKey]);

  const setView = (v: ViewId) => useStore.getState().setView(v);

  return (
    <nav className="bg-sidebar border-sidebar-border flex h-full w-60 shrink-0 flex-col border-r" aria-label="Lists">
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
              onClick={() => useStore.getState().set({ sidebarOpen: false })}
              aria-label="Hide sidebar"
            >
              <PanelLeftIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide sidebar (Ctrl+B)</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {SMART_VIEWS.map((v, i) => (
            <NavItem
              key={v.id}
              active={view === v.id}
              onClick={() => setView(v.id)}
              icon={ICONS[v.id]}
              label={v.label}
              count={counts.smart.get(v.id) ?? 0}
              shortcut={`Ctrl+${i + 1}`}
            />
          ))}
        </div>

        <div className="text-muted-foreground mt-5 mb-1 flex items-center px-2 text-xs font-medium tracking-wide uppercase">
          <span className="flex-1">Lists</span>
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
        </div>
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
      </div>

      <div className="border-sidebar-border flex items-center gap-1 border-t p-2">
        <SyncIndicator />
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
