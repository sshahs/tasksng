import { useState } from "react";
import { format } from "date-fns";
import { BellPlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { parseDue } from "@/lib/dates";
import { DEFAULT_REMINDERS, reminderLabel, reminderPresets, reminderTime, sameReminder } from "@/lib/reminders";
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
  const [custom, setCustom] = useState("");
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
          <PopoverContent className="w-64 p-1" align="start">
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
            <form
              className="flex items-center gap-1 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new Date(custom);
                if (Number.isNaN(d.getTime())) return;
                add({ at: d.toISOString().replace(/\.\d{3}Z$/, "Z") });
                setCustom("");
              }}
            >
              <Input
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="h-8 flex-1 text-xs"
                aria-label="Custom reminder time"
              />
              <Button type="submit" size="sm" className="h-8" disabled={!custom}>
                Add
              </Button>
            </form>
            {!settings?.reminders && settings && (
              <p className="text-muted-foreground px-2 pb-1.5 text-xs">Reminders are turned off in Settings.</p>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
