import { lazy, Suspense, useState } from "react";
import { CalendarIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { dueTime, formatDue, isOverdue, parseDue, quickDates, toDue } from "@/lib/dates";
import { cn } from "@/lib/utils";

// The calendar (react-day-picker) is loaded on demand to keep start-up lean;
// it is prefetched once the app is idle so the first open is still instant.
const loadCalendar = () => import("@/components/ui/calendar");
const Calendar = lazy(() => loadCalendar().then((m) => ({ default: m.Calendar })));
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
  idle(() => void loadCalendar());
}

export function DuePicker({
  value,
  onChange,
  completed,
  showIcon = true,
  className,
  placeholder = "Add due date",
  prefix = "",
  warnOverdue = true,
  disabled,
}: {
  value: string | null;
  onChange: (due: string | null) => void;
  completed?: boolean;
  showIcon?: boolean;
  className?: string;
  placeholder?: string;
  /** Text in front of the date, e.g. "Starts". */
  prefix?: string;
  warnOverdue?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const info = parseDue(value);
  const time = dueTime(info);
  const overdue = warnOverdue && !completed && isOverdue(info);

  // The time being typed. It is saved when the field is left, on Enter or when
  // the picker closes. Saving each complete value as it was typed (00:06,
  // then 09:06, …) wrote the saved task back into the field mid-typing, which
  // restarts the browser's typing in the field.
  const [timeDraft, setTimeDraft] = useState("");
  const [editingTime, setEditingTime] = useState(false);
  const currentTime = (editingTime ? timeDraft : time) || null;

  const pick = (day: Date | undefined, t: string | null = currentTime) => {
    if (!day) return;
    onChange(toDue(day, t));
  };
  const commitTime = () => {
    setEditingTime(false);
    if (timeDraft === (time ?? "")) return;
    // Clearing the field keeps the day and drops the time.
    if (!timeDraft && !info) return;
    pick(info?.date ?? new Date(), timeDraft || null);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o && editingTime) commitTime();
        setOpen(o);
      }}
    >
      <div className={cn("flex items-center gap-1", className)}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            className={cn(
              "h-8 flex-1 justify-start px-2 font-normal",
              !info && "text-muted-foreground",
              overdue && "text-destructive hover:text-destructive",
            )}
          >
            {showIcon && <CalendarIcon />}
            {info ? `${prefix ? `${prefix} ` : ""}${formatDue(info)}` : placeholder}
          </Button>
        </PopoverTrigger>
        {info && !disabled && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground size-7"
            onClick={() => onChange(null)}
            aria-label={`Remove ${placeholder.replace(/^Add /, "")}`}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex gap-1 p-2">
          {quickDates().map((q) => (
            <Button
              key={q.label}
              variant="secondary"
              size="sm"
              className="h-7 flex-1 text-xs"
              onClick={() => {
                pick(q.date);
                setOpen(false);
              }}
            >
              {q.label}
            </Button>
          ))}
        </div>
        <Separator />
        <Suspense fallback={<div className="h-[296px] w-[252px]" />}>
          <Calendar
            mode="single"
            selected={info?.date}
            defaultMonth={info?.date}
            weekStartsOn={1}
            onSelect={(d) => {
              pick(d);
              setEditingTime(false);
              if (!currentTime) setOpen(false);
            }}
          />
        </Suspense>
        <Separator />
        <div className="flex items-center gap-2 p-2">
          <span className="text-muted-foreground text-xs">Time</span>
          <Input
            type="time"
            className="h-8 flex-1"
            value={editingTime ? timeDraft : (time ?? "")}
            onFocus={() => {
              setTimeDraft(time ?? "");
              setEditingTime(true);
            }}
            onChange={(e) => {
              setEditingTime(true);
              setTimeDraft(e.target.value);
            }}
            onBlur={commitTime}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTime();
              }
            }}
            aria-label="Time"
          />
          {time && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setEditingTime(false);
                pick(info?.date, null);
              }}
            >
              All day
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
