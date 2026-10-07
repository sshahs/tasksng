import { useState } from "react";
import { addDays, format } from "date-fns";
import { BellPlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateTimeFields } from "@/components/date-time-fields";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { formatDue, parseDue } from "@/lib/dates";
import {
  DEFAULT_REMINDERS,
  relativeReminder,
  reminderLabel,
  reminderPresets,
  reminderTime,
  sameReminder,
  type ReminderUnit,
} from "@/lib/reminders";
import { useStore } from "@/lib/store";
import type { Reminder, Task } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ReminderPicker({
  task,
  readOnly,
  onChange,
}: {
  task: Task;
  readOnly: boolean;
  onChange: (reminders: Reminder[]) => void;
}) {
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const now = new Date();
  const presets = reminderPresets(task, now).filter((p) => !task.reminders.some((r) => sameReminder(r, p.reminder)));
  const due = parseDue(task.due);
  const automatic =
    !task.completed &&
    task.reminders.length === 0 &&
    !!settings?.reminders &&
    settings.defaultReminder !== null &&
    !!due?.hasTime &&
    (DEFAULT_REMINDERS.find((d) => d.offset === settings.defaultReminder)?.label ?? null);

  const add = (r: Reminder) => {
    onChange([...task.reminders, r]);
    setOpen(false);
  };
  const remove = (i: number) => onChange(task.reminders.filter((_, j) => j !== i));

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 py-0.5">
      {task.reminders.map((r, i) => {
        const at = reminderTime(r, task);
        const past = !!at && at.getTime() < now.getTime();
        return (
          <span
            key={i}
            className={cn(
              "bg-secondary text-secondary-foreground inline-flex h-7 items-center gap-1 rounded-md pr-1 pl-2 text-xs",
              past && "text-muted-foreground line-through decoration-muted-foreground/50",
            )}
            title={at ? format(at, "EEEE d MMMM yyyy, HH:mm") : undefined}
          >
            {reminderLabel(r, task, now)}
            {!readOnly && (
              <button
                className="hover:bg-background/60 text-muted-foreground hover:text-foreground rounded-sm p-0.5"
                onClick={() => remove(i)}
                aria-label="Remove reminder"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </span>
        );
      })}
      {!readOnly && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("text-muted-foreground h-8 px-2 font-normal", task.reminders.length > 0 && "w-8 px-0")}
              aria-label="Add reminder"
            >
              {task.reminders.length > 0 ? (
                <BellPlusIcon />
              ) : automatic ? (
                <span>
                  {automatic} <span className="text-muted-foreground/70">(automatic)</span>
                </span>
              ) : (
                "Add reminder"
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[21rem] max-w-[calc(100vw-2rem)] p-1" align="start">
            <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-xs">
              {due ? "Remind me" : "Remind me (set a due date for more options)"}
            </p>
            {presets.map((p) => (
              <button
                key={p.label}
                className="hover:bg-accent w-full rounded-sm px-2 py-1.5 text-left text-sm"
                onClick={() => add(p.reminder)}
              >
                {p.label}
              </button>
            ))}
            <Separator className="my-1" />
            <CustomReminder key={String(open)} task={task} onAdd={add} />
            {!settings?.reminders && settings && (
              <p className="text-muted-foreground px-2 pb-1.5 text-xs">Reminders are turned off in Settings.</p>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

const UNITS: { value: ReminderUnit; one: string; many: string }[] = [
  { value: "minutes", one: "minute", many: "minutes" },
  { value: "hours", one: "hour", many: "hours" },
  { value: "days", one: "day", many: "days" },
  { value: "weeks", one: "week", many: "weeks" },
];

/** A reminder of your own: some time before or after a date, or on a day and time. */
function CustomReminder({ task, onAdd }: { task: Task; onAdd: (r: Reminder) => void }) {
  const anchors = (["due", "start"] as const).filter((f) => !!task[f]);
  const [mode, setMode] = useState<"relative" | "on">(anchors.length ? "relative" : "on");
  const [amount, setAmount] = useState("1");
  const [unit, setUnit] = useState<ReminderUnit | null>(null);
  const [when, setWhen] = useState(`before-${anchors[0] ?? "due"}`);
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [date, setDate] = useState(() => format(parseDue(task.due)?.date ?? addDays(new Date(), 1), "yyyy-MM-dd"));
  const [time, setTime] = useState("09:00");

  const [direction, related] = when.split("-") as ["before" | "after", "due" | "start"];
  const anchor = parseDue(task[related]);
  const allDay = !!anchor && !anchor.hasTime;
  const units = allDay ? UNITS.filter((u) => u.value === "days" || u.value === "weeks") : UNITS;
  const chosenUnit = unit && units.some((u) => u.value === unit) ? unit : allDay ? "days" : "hours";
  const n = Number(amount);

  let reminder: Reminder | null = null;
  if (mode === "relative" && anchor && amount !== "" && Number.isFinite(n) && n >= 0) {
    if (!allDay || timeOfDay) reminder = relativeReminder(n, chosenUnit, direction === "before", related, allDay ? timeOfDay : null);
  } else if (mode === "on" && date && time) {
    const at = new Date(`${date}T${time}:00`);
    if (!Number.isNaN(at.getTime())) reminder = { at: at.toISOString().replace(/\.\d{3}Z$/, "Z") };
  }
  const at = reminder && reminderTime(reminder, task);
  const taken = !!reminder && task.reminders.some((r) => sameReminder(r, reminder));

  return (
    <form
      className="grid gap-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reminder && !taken) onAdd(reminder);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Custom</span>
        {anchors.length > 0 && (
          <div className="bg-muted flex rounded-md p-0.5 text-xs" role="radiogroup" aria-label="Kind of reminder">
            {(
              [
                ["relative", anchors.length > 1 ? "Before a date" : `Before ${anchors[0]}`],
                ["on", "On a day"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  mode === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "relative" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={999}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-8 w-14 px-2"
            aria-label="How many"
          />
          <Select value={chosenUnit} onValueChange={(v) => setUnit(v as ReminderUnit)}>
            <SelectTrigger size="sm" className="w-[6.75rem] px-2.5" aria-label="Unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {units.map((u) => (
                <SelectItem key={u.value} value={u.value}>
                  {n === 1 ? u.one : u.many}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={when} onValueChange={setWhen}>
            <SelectTrigger size="sm" className="min-w-0 flex-1 px-2.5" aria-label="Before or after">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {anchors.flatMap((f) =>
                (["before", "after"] as const).map((d) => (
                  <SelectItem key={`${d}-${f}`} value={`${d}-${f}`}>
                    {d} {f}
                  </SelectItem>
                )),
              )}
            </SelectContent>
          </Select>
          {allDay && (
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              at
              <Input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} className="h-8 w-28 px-2" />
            </label>
          )}
        </div>
      ) : (
        <DateTimeFields date={date} time={time} onDate={setDate} onTime={setTime} />
      )}

      <div className="flex items-center justify-between gap-2">
        <span className={cn("min-w-0 truncate text-xs", taken ? "text-muted-foreground" : "text-muted-foreground/80")}>
          {taken ? "Already set" : at ? formatDue({ date: at, hasTime: true }) : ""}
        </span>
        <Button type="submit" size="sm" className="h-8 shrink-0" disabled={!reminder || taken}>
          Add reminder
        </Button>
      </div>
    </form>
  );
}
