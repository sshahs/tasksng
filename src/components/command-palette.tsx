import { useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  CircleIcon,
  EyeIcon,
  HashIcon,
  LogOutIcon,
  ListPlusIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useTheme } from "@/hooks/use-theme";
import { api, isTauri } from "@/lib/api";
import { formatDue, parseDue } from "@/lib/dates";
import { SMART_VIEWS, useStore, type ViewId } from "@/lib/store";
import { tagCounts } from "@/lib/views";

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const tasks = useStore((s) => s.tasks);
  const lists = useStore((s) => s.lists);
  const showCompleted = useStore((s) => s.showCompleted);
  const savedSearches = useStore((s) => s.savedSearches);
  const { resolved, setTheme } = useTheme();
  const [query, setQuery] = useState("");

  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const tags = useMemo(() => (open ? tagCounts(Object.values(tasks)) : []), [open, tasks]);
  const destinations: { id: ViewId; label: string; icon: React.ReactNode }[] = [
    ...SMART_VIEWS.map((v) => ({ id: v.id as ViewId, label: v.label, icon: <CircleIcon /> })),
    ...lists.map((l) => ({
      id: `list:${l.id}` as ViewId,
      label: l.name,
      icon: <span className="m-[3px] size-2.5 rounded-full" style={{ background: l.color ?? "var(--muted-foreground)" }} />,
    })),
    ...savedSearches.map((s) => ({ id: `search:${s.id}` as ViewId, label: s.name, icon: <SearchIcon /> })),
    ...tags.map((t) => ({ id: `tag:${t.tag}` as ViewId, label: `#${t.tag}`, icon: <HashIcon /> })),
  ];
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.values(tasks)
      .filter((t) => t.summary.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .sort((a, b) => Number(a.completed) - Number(b.completed) || a.summary.localeCompare(b.summary))
      .slice(0, 30);
  }, [tasks, query]);

  const close = () => {
    useStore.getState().set({ paletteOpen: false });
    setQuery("");
  };
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => (o ? useStore.getState().set({ paletteOpen: true }) : close())}
      title="Command palette"
      description="Search tasks and run commands"
      showCloseButton={false}
      commandProps={{ shouldFilter: false }}
    >
      <CommandInput placeholder="Search tasks or type a command…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>Nothing found.</CommandEmpty>
        {matches.length > 0 && (
          <CommandGroup heading="Tasks">
            {matches.map((t) => {
              const list = listById.get(t.listId);
              const due = parseDue(t.due);
              return (
                <CommandItem
                  key={t.id}
                  value={t.id}
                  onSelect={run(() => useStore.getState().openTask(t.id))}
                >
                  {t.completed ? <CheckCircle2Icon /> : <CircleIcon />}
                  <span className={t.completed ? "text-muted-foreground truncate line-through" : "truncate"}>
                    {t.summary || "Untitled task"}
                  </span>
                  <CommandShortcut className="flex items-center gap-2 tracking-normal">
                    {due && <span>{formatDue(due)}</span>}
                    {list && (
                      <span className="flex items-center gap-1">
                        <span className="size-2 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />
                        {list.name}
                      </span>
                    )}
                  </CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        <Group query={query} heading="Go to">
          {destinations.map((v) => (
            <Item key={v.id} query={query} label={v.label} onSelect={run(() => useStore.getState().setView(v.id))}>
              {v.icon}
              {v.label}
            </Item>
          ))}
        </Group>
        <Group query={query} heading="Commands">
          <Item query={query} label="New task" onSelect={run(() => useStore.setState((s) => ({ focusQuickAdd: s.focusQuickAdd + 1 })))}>
            <PlusIcon /> New task <CommandShortcut>N</CommandShortcut>
          </Item>
          <Item query={query} label="New list" onSelect={run(() => useStore.getState().set({ listDialog: { mode: "create" } }))}>
            <ListPlusIcon /> New list
          </Item>
          <Item query={query} label="Sync now" onSelect={run(() => void useStore.getState().sync(true))}>
            <RefreshCwIcon /> Sync now <CommandShortcut>F5</CommandShortcut>
          </Item>
          <Item
            query={query}
            label={showCompleted ? "Hide completed tasks" : "Show completed tasks"}
            onSelect={run(() => useStore.getState().set({ showCompleted: !showCompleted }))}
          >
            <EyeIcon /> {showCompleted ? "Hide completed tasks" : "Show completed tasks"} <CommandShortcut>Ctrl H</CommandShortcut>
          </Item>
          <Item
            query={query}
            label={resolved === "dark" ? "Light theme" : "Dark theme"}
            onSelect={run(() => setTheme(resolved === "dark" ? "light" : "dark"))}
          >
            {resolved === "dark" ? <SunIcon /> : <MoonIcon />} Switch to {resolved === "dark" ? "light" : "dark"} theme
          </Item>
          <Item query={query} label="Settings" onSelect={run(() => useStore.getState().set({ settingsOpen: true }))}>
            <SettingsIcon /> Settings
          </Item>
          {isTauri && (
            <Item query={query} label="Quit TasksNG" onSelect={run(() => void api.quitApp())}>
              <LogOutIcon /> Quit TasksNG
            </Item>
          )}
        </Group>
      </CommandList>
    </CommandDialog>
  );
}

/** Groups/items that filter themselves (cmdk filtering is off so task search stays fast). */
function Group({ query, heading, children }: { query: string; heading: string; children: React.ReactNode }) {
  const items = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean) as React.ReactElement<{ label: string }>[];
  const visible = items.filter((c) => matchesQuery(c.props.label, query));
  if (!visible.length) return null;
  return <CommandGroup heading={heading}>{visible}</CommandGroup>;
}

function Item({
  label,
  onSelect,
  children,
}: {
  query: string;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <CommandItem value={`cmd:${label}`} onSelect={onSelect}>
      {children}
    </CommandItem>
  );
}

function matchesQuery(label: string, query: string) {
  const q = query.trim().toLowerCase();
  return !q || label.toLowerCase().includes(q);
}
