import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarIcon, ChevronDownIcon, HashIcon, PlusIcon, RepeatIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { dateOnly, formatDue, parseDue } from "@/lib/dates";
import { setPref } from "@/lib/prefs";
import { parseQuickAdd } from "@/lib/quick-add";
import { listIdOf, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PriorityFlag, PRIORITIES, priorityLevel } from "./priority";
import { repeatLabel } from "./repeat";

export function QuickAdd() {
  const view = useStore((s) => s.view);
  const lists = useStore((s) => s.lists);
  const focusQuickAdd = useStore((s) => s.focusQuickAdd);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const viewList = listIdOf(view);
  const listId = viewList ?? target ?? useStore.getState().defaultListId();
  const list = lists.find((l) => l.id === listId);
  const parsed = useMemo(() => parseQuickAdd(text), [text]);

  useEffect(() => {
    if (focusQuickAdd) inputRef.current?.focus();
  }, [focusQuickAdd]);

  const submit = async () => {
    if (!parsed.summary || !listId) return;
    let { due, priority } = parsed;
    // Smart views give new tasks the property that makes them show up there.
    if (!due && view === "today") due = dateOnly(new Date());
    if (!due && view === "upcoming") due = dateOnly(new Date(Date.now() + 86_400_000));
    if (priority == null && view === "important") priority = 1;
    setText("");
    const task = await useStore.getState().createTask(listId, {
      summary: parsed.summary,
      due,
      priority,
      categories: parsed.categories,
      rrule: parsed.rrule,
    });
    if (task) {
      requestAnimationFrame(() =>
        document.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    }
  };

  const due = parseDue(parsed.due);
  const hasChips = !!(parsed.due || parsed.priority || parsed.categories.length || parsed.rrule) && text !== parsed.summary;
  const writable = lists.filter((l) => !l.readOnly);

  if (!writable.length) return null;

  return (
    <div className="px-4 pb-2">
      <div
        className={cn(
          "bg-muted/50 flex items-center gap-2 rounded-lg border border-transparent px-3 transition-colors",
          focused && "bg-background border-ring ring-ring/30 ring-[3px]",
        )}
      >
        <PlusIcon className={cn("size-4 shrink-0", focused ? "text-primary" : "text-muted-foreground")} />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              setText("");
              e.currentTarget.blur();
            }
          }}
          placeholder={focused ? "e.g. Pay rent tomorrow 9am !1 #home every month" : "Add a task"}
          aria-label="Add a task"
          className="placeholder:text-muted-foreground h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {!viewList && list && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="text-muted-foreground hover:text-foreground hover:bg-accent flex max-w-40 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none"
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />
              <span className="truncate">{list.name}</span>
              <ChevronDownIcon className="size-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Add new tasks to</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={list.id}
                onValueChange={(id) => {
                  setTarget(id);
                  setPref("default-list", id);
                  inputRef.current?.focus();
                }}
              >
                {writable.map((l) => (
                  <DropdownMenuRadioItem key={l.id} value={l.id}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: l.color ?? "var(--muted-foreground)" }} />
                    <span className="truncate">{l.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {focused && !text && (
          <span className="text-muted-foreground hidden shrink-0 items-center gap-1 text-xs lg:flex">
            <Kbd>Enter</Kbd> to add
          </span>
        )}
      </div>
      {hasChips && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1">
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
        </div>
      )}
    </div>
  );
}
