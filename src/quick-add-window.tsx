import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSignIcon, CalendarIcon, CheckIcon, HashIcon, HourglassIcon, PlusIcon, RepeatIcon } from "lucide-react";

import { repeatLabel } from "@/components/repeat";
import { PRIORITIES, PriorityFlag, priorityLevel } from "@/components/priority";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { useTheme } from "@/hooks/use-theme";
import { api, isTauri, on, windowReady } from "@/lib/api";
import { formatDue, parseDue } from "@/lib/dates";
import { getPref, setPref } from "@/lib/prefs";
import { parseQuickAdd, resolveList } from "@/lib/quick-add";
import type { TaskList } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The small window opened by the global shortcut (Win+Alt+N) or the tray
 * menu: type a task, press Enter, and you're back where you were.
 */
export function QuickAddWindow() {
  useTheme();
  const [lists, setLists] = useState<TaskList[]>([]);
  const [listId, setListId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const snap = await api.getSnapshot().catch(() => null);
    const writable = (snap?.lists ?? []).filter((l) => !l.readOnly).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name));
    setLists(writable);
    const saved = getPref<string | null>("default-list", null);
    setListId((cur) => (cur && writable.some((l) => l.id === cur) ? cur : (writable.find((l) => l.id === saved) ?? writable[0])?.id ?? null));
  }, []);

  const reset = useCallback(() => {
    setText("");
    setAdded(null);
    setError(null);
    void load();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [load]);

  useEffect(() => {
    void load().then(windowReady);
    const un = on<null>("quick-add-open", reset);
    return () => void un.then((f) => f());
  }, [load, reset]);

  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  const mentioned = resolveList(parsed.list, lists);
  const target = mentioned ?? lists.find((l) => l.id === listId) ?? null;
  const due = parseDue(parsed.due);
  const start = parseDue(parsed.start);

  const hide = () => {
    if (isTauri) void api.hideQuickAdd();
  };

  const submit = async (keepOpen: boolean) => {
    if (!parsed.summary.trim() || !target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTask(target.id, {
        summary: parsed.summary,
        due: parsed.due,
        start: parsed.start,
        priority: parsed.priority,
        categories: parsed.categories,
        rrule: parsed.rrule,
      });
      setText("");
      setAdded(`Added to ${target.name}`);
      if (!keepOpen) window.setTimeout(hide, 350);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-background flex h-full flex-col overflow-hidden border" onKeyDown={(e) => e.key === "Escape" && hide()}>
      <div className="flex items-center gap-3 px-4 pt-3">
        {added && !text ? <CheckIcon className="text-primary size-5 shrink-0" /> : <PlusIcon className="text-primary size-5 shrink-0" />}
        <input
          ref={inputRef}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAdded(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(e.shiftKey);
            }
          }}
          placeholder={added ?? "New task — e.g. Call Sam tomorrow 3pm !1 #work @personal"}
          aria-label="New task"
          className="placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-base outline-none"
        />
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-1.5 px-4 pl-12">
        {parsed.list && (
          <Badge variant={mentioned ? "secondary" : "destructive"} className="font-normal">
            <AtSignIcon /> {mentioned ? mentioned.name : `No list “${parsed.list}”`}
          </Badge>
        )}
        {start && (
          <Badge variant="secondary" className="font-normal">
            <HourglassIcon /> Starts {formatDue(start)}
          </Badge>
        )}
        {due && (
          <Badge variant="secondary" className="font-normal">
            <CalendarIcon /> {formatDue(due)}
          </Badge>
        )}
        {parsed.priority != null && (
          <Badge variant="secondary" className="font-normal">
            <PriorityFlag priority={parsed.priority} />
            {PRIORITIES.find((p) => p.level === priorityLevel(parsed.priority!))?.label}
          </Badge>
        )}
        {parsed.rrule && (
          <Badge variant="secondary" className="font-normal">
            <RepeatIcon /> {repeatLabel(parsed.rrule)}
          </Badge>
        )}
        {parsed.categories.map((c) => (
          <Badge key={c} variant="secondary" className="font-normal">
            <HashIcon /> {c}
          </Badge>
        ))}
        {error && <span className="text-destructive text-xs">{error}</span>}
      </div>
      <div className="bg-muted/40 text-muted-foreground mt-auto flex items-center gap-3 border-t px-4 py-2 text-xs">
        {lists.length > 0 ? (
          <label className="flex min-w-0 items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: target?.color ?? "var(--muted-foreground)" }}
            />
            {/* A native select: its menu may extend past this small window. */}
            <select
              value={target?.id ?? ""}
              disabled={!!mentioned}
              onChange={(e) => {
                setListId(e.target.value);
                setPref("default-list", e.target.value);
                inputRef.current?.focus();
              }}
              className={cn("text-foreground max-w-48 truncate bg-transparent outline-none", mentioned && "opacity-60")}
              aria-label="List"
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>Sign in to TasksNG first</span>
        )}
        <div className="flex-1" />
        <span className="hidden items-center gap-1 sm:flex">
          <Kbd>Enter</Kbd> add
        </span>
        <span className="hidden items-center gap-1 sm:flex">
          <Kbd>Shift Enter</Kbd> add another
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </div>
  );
}
