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
}: {
  value: string | null;
  onChange: (due: string | null) => void;
  completed?: boolean;
  showIcon?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const info = parseDue(value);
  const time = dueTime(info);
  const overdue = !completed && isOverdue(info);

  const pick = (day: Date | undefined, t: string | null = time) => {
    if (!day) return;
    onChange(toDue(day, t));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("flex items-center gap-1", className)}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 flex-1 justify-start px-2 font-normal",
              !info && "text-muted-foreground",
              overdue && "text-destructive hover:text-destructive",
            )}
          >
            {showIcon && <CalendarIcon />}
            {info ? formatDue(info) : "Add due date"}
          </Button>
        </PopoverTrigger>
        {info && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground size-7"
            onClick={() => onChange(null)}
            aria-label="Remove due date"
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
              if (!time) setOpen(false);
            }}
          />
        </Suspense>
        <Separator />
        <div className="flex items-center gap-2 p-2">
          <span className="text-muted-foreground text-xs">Time</span>
          <Input
            type="time"
            className="h-8 flex-1"
            value={time ?? ""}
            onChange={(e) => pick(info?.date ?? new Date(), e.target.value || null)}
          />
          {time && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => pick(info?.date, null)}>
              All day
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
