import { useState } from "react";
import { format } from "date-fns";
import { AlarmClockIcon, AlarmClockOffIcon, CalendarClockIcon } from "lucide-react";

import { DateTimeFields } from "@/components/date-time-fields";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuShortcut } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuShortcut } from "@/components/ui/dropdown-menu";
import { isSnoozed, snoozeLabel, snoozePresets } from "@/lib/snooze";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The snooze choices, for a context menu or a dropdown menu. */
export function SnoozeItems({ task, kind }: { task: Task; kind: "context" | "dropdown" }) {
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Shortcut = kind === "context" ? ContextMenuShortcut : DropdownMenuShortcut;
  const snooze = (at: Date | null) => void useStore.getState().snooze(task.id, at);
  return (
    <>
      {snoozePresets().map((p) => (
        <Item key={p.id} onSelect={() => snooze(p.at)}>
          {p.label}
          <Shortcut>{p.id === "tomorrow" ? `Z · ${p.hint}` : p.hint}</Shortcut>
        </Item>
      ))}
      <Item onSelect={() => useStore.getState().set({ snoozeDialog: task.id })}>
        <CalendarClockIcon /> Pick a date and time…
        <Shortcut>⇧Z</Shortcut>
      </Item>
      {isSnoozed(task) && (
        <Item onSelect={() => snooze(null)}>
          <AlarmClockOffIcon /> Bring back now
        </Item>
      )}
    </>
  );
}

/** "Snooze until…" with a date and time of your choosing. */
export function SnoozeDialog() {
  const id = useStore((s) => s.snoozeDialog);
  const task = useStore((s) => (s.snoozeDialog ? s.tasks[s.snoozeDialog] : undefined));
  const close = () => useStore.getState().set({ snoozeDialog: null });
  return (
    <Dialog open={!!id && !!task} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-sm">
        {task && <SnoozeForm key={task.id} task={task} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function SnoozeForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const presets = snoozePresets();
  const first = task.snoozedUntil && isSnoozed(task) ? new Date(task.snoozedUntil) : presets.find((p) => p.id === "tomorrow")!.at;
  const [date, setDate] = useState(format(first, "yyyy-MM-dd"));
  const [time, setTime] = useState(format(first, "HH:mm"));
  const at = new Date(`${date}T${time}:00`);
  const valid = !Number.isNaN(at.getTime()) && at.getTime() > Date.now();
  const snooze = (when: Date) => {
    void useStore.getState().snooze(task.id, when);
    onDone();
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) snooze(at);
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlarmClockIcon className="size-5 text-amber-500" /> Snooze
        </DialogTitle>
        <DialogDescription>
          “{task.summary || "Untitled task"}” is out of the way until then and comes back with a notification.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => snooze(p.at)}
            className="hover:bg-accent rounded-md border px-2.5 py-1 text-xs transition-colors"
          >
            {p.label} <span className="text-muted-foreground">{p.hint}</span>
          </button>
        ))}
      </div>
      <DateTimeFields date={date} time={time} min={format(new Date(), "yyyy-MM-dd")} onDate={setDate} onTime={setTime} />
      <DialogFooter>
        {isSnoozed(task) && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              void useStore.getState().snooze(task.id, null);
              onDone();
            }}
          >
            Bring back now
          </Button>
        )}
        <Button type="submit" disabled={!valid} className={cn(!valid && "opacity-60")}>
          Snooze {valid ? snoozeLabel(at.toISOString()) : ""}
        </Button>
      </DialogFooter>
    </form>
  );
}
