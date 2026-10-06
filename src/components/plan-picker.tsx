import { useState } from "react";
import { format } from "date-fns";
import { CalendarClockIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDue, parseDue } from "@/lib/dates";
import { DEFAULT_MINUTES, formatMinutes, iso, snap } from "@/lib/planner";
import { useStore } from "@/lib/store";
import type { Task, TaskPatch } from "@/lib/types";
import { cn } from "@/lib/utils";

const LENGTHS = [15, 30, 45, 60, 90, 120];

/** When to work on a task (the day planner's time block), without dragging. */
export function PlanPicker({ task, readOnly, onChange }: { task: Task; readOnly: boolean; onChange: (p: TaskPatch) => void }) {
  const [open, setOpen] = useState(false);
  const planned = parseDue(task.planned);
  const minutes = task.plannedMinutes ?? DEFAULT_MINUTES;
  const initial = () => {
    const at = planned?.date ?? new Date();
    const time = planned ? at.getHours() * 60 + at.getMinutes() : snap(at.getHours() * 60 + at.getMinutes() + 15);
    return { date: format(at, "yyyy-MM-dd"), time: `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`, minutes };
  };
  const [draft, setDraft] = useState(initial);

  const save = () => {
    const at = new Date(`${draft.date}T${draft.time}:00`);
    if (Number.isNaN(at.getTime())) return;
    onChange({ planned: iso(at), plannedMinutes: draft.minutes });
    setOpen(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(o) => {
          if (o) setDraft(initial());
          setOpen(o);
        }}
      >
        <PopoverTrigger asChild disabled={readOnly}>
          <Button variant="ghost" size="sm" className={cn("-ml-2 h-8 min-w-0 justify-start font-normal", !planned && "text-muted-foreground")}>
            <span className="truncate">{planned ? `Planned ${formatDue(planned)} · ${formatMinutes(minutes)}` : "Plan a time"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-72 gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Day</span>
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                className="border-input dark:bg-input/30 h-8 rounded-md border bg-transparent px-2 text-sm"
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Time</span>
              <input
                type="time"
                step={900}
                value={draft.time}
                onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
                className="border-input dark:bg-input/30 h-8 rounded-md border bg-transparent px-2 text-sm"
              />
            </label>
          </div>
          <div className="grid gap-1 text-xs">
            <span className="text-muted-foreground">For</span>
            <div className="flex flex-wrap gap-1">
              {LENGTHS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, minutes: m }))}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs transition-colors",
                    draft.minutes === m ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent",
                  )}
                >
                  {formatMinutes(m)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={() => {
                setOpen(false);
                useStore.getState().setView("plan");
              }}
            >
              <CalendarClockIcon /> Open the planner
            </Button>
            <Button size="sm" onClick={save}>
              Plan
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {planned && !readOnly && (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground shrink-0" onClick={() => onChange({ planned: null })} aria-label="Remove from the plan">
          <XIcon />
        </Button>
      )}
    </div>
  );
}
