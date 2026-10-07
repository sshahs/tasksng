import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HistoryIcon, MonitorSmartphoneIcon, PencilIcon, PlusIcon, RotateCcwIcon, ArchiveIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { differingFields } from "@/lib/conflicts";
import { changesIn, restorePatch, sourceLabel, versionTime } from "@/lib/history";
import { useStore } from "@/lib/store";
import type { Task, TaskVersion, VersionSource } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICON: Record<VersionSource, typeof PencilIcon> = {
  created: PlusIcon,
  here: PencilIcon,
  elsewhere: MonitorSmartphoneIcon,
  earlier: ArchiveIcon,
};

/** Earlier versions of a task, what each one changed, and a way back to any of them. */
export function HistoryDialog() {
  const id = useStore((s) => s.historyFor);
  const task = useStore((s) => (s.historyFor ? s.tasks[s.historyFor] : undefined));
  const close = () => useStore.getState().set({ historyFor: null });
  return (
    <Dialog open={!!id && !!task} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] gap-4 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="text-primary size-5" /> History
          </DialogTitle>
          <DialogDescription className="break-words">
            “{task?.summary || "Untitled task"}” as it was changed on this and other devices.
          </DialogDescription>
        </DialogHeader>
        {task && <Timeline key={task.id} task={task} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function Timeline({ task, onDone }: { task: Task; onDone: () => void }) {
  const tasks = useStore((s) => s.tasks);
  const readOnly = useStore((s) => !!s.lists.find((l) => l.id === task.listId)?.readOnly);
  const [versions, setVersions] = useState<TaskVersion[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  // Fresh whenever the task changes (an edit, a sync, a restore).
  useEffect(() => {
    let live = true;
    api
      .taskHistory(task.id)
      .then((v) => live && setVersions(v))
      .catch(() => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [task]);

  if (!versions) return <div className="text-muted-foreground py-10 text-center text-sm">Loading…</div>;
  if (!versions.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center text-sm">
        <HistoryIcon className="size-6 opacity-60" />
        No earlier versions yet. Changes from now on are kept here.
      </div>
    );
  }

  const restore = async (v: TaskVersion) => {
    const patch = restorePatch(task, v.task);
    const back = restorePatch(v.task, task);
    if (!patch) return;
    onDone();
    await useStore.getState().updateTask(task.id, patch);
    toast.success("Version restored", {
      description: `${task.summary || "Untitled task"} · as of ${versionTime(v.at)}`,
      action: back ? { label: "Undo", onClick: () => void useStore.getState().updateTask(task.id, back) } : undefined,
    });
  };

  // The newest version that looks like the task now; older look-alikes can't be restored either.
  const now = versions.findIndex((v) => differingFields(task, v.task).length === 0);

  return (
    <ol className="relative grid gap-1">
      {/* The line the dots sit on. */}
      <span className="bg-border absolute top-4 bottom-4 left-[15px] w-px" aria-hidden />
      {versions.map((v, i) => {
        const Icon = ICON[v.source];
        const changes = changesIn(versions, i);
        const same = differingFields(task, v.task).length === 0;
        const current = i === now;
        const open = picked === i && !same;
        const willChange = open ? differingFields(task, v.task) : [];
        return (
          <li
            key={`${v.at}-${i}`}
            className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both relative duration-300"
            style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}
          >
            <button
              type="button"
              disabled={same}
              aria-expanded={open}
              onClick={() => setPicked(open ? null : i)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg px-1 py-2 text-left transition-colors",
                !same && "hover:bg-accent/60",
                open && "bg-accent/60",
              )}
            >
              <span
                className={cn(
                  "bg-background relative z-10 flex size-[30px] shrink-0 items-center justify-center rounded-full border",
                  current && "border-primary text-primary",
                  v.source === "elsewhere" && !current && "text-amber-600 dark:text-amber-400",
                )}
              >
                <Icon className="size-3.5" />
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{sourceLabel(v.source)}</span>
                  <span className="text-muted-foreground text-xs">{versionTime(v.at)}</span>
                  {current && (
                    <span className="bg-primary/10 text-primary rounded px-1.5 py-px text-[11px] font-medium">Current</span>
                  )}
                </span>
                {changes.length > 0 ? (
                  <span className="grid gap-0.5 text-xs">
                    {changes.map((f) => (
                      <span key={f.key} className="text-muted-foreground flex min-w-0 gap-1.5">
                        <span className="shrink-0">{f.label}:</span>
                        <span className="text-foreground/90 truncate">{f.show(v.task, tasks)}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted-foreground truncate text-xs">{v.task.summary || "Untitled task"}</span>
                )}
              </span>
            </button>
            {open && (
              <div className="animate-in fade-in-0 slide-in-from-top-1 ml-[42px] grid gap-3 pt-1 pb-3 duration-200">
                <div className="bg-muted/50 grid gap-1.5 rounded-lg p-3 text-xs">
                  <span className="text-muted-foreground font-medium">Restoring changes</span>
                  {willChange.map((f) => (
                    <span key={f.key} className="grid grid-cols-[5rem_1fr] gap-2">
                      <span className="text-muted-foreground">{f.label}</span>
                      <span className="min-w-0 break-words">
                        <span className="text-muted-foreground line-through">{f.show(task, tasks)}</span>
                        {" → "}
                        <span className={cn(f.key === "description" && "whitespace-pre-wrap")}>{f.show(v.task, tasks)}</span>
                      </span>
                    </span>
                  ))}
                </div>
                <div>
                  <Button size="sm" disabled={readOnly} onClick={() => void restore(v)}>
                    <RotateCcwIcon /> Restore this version
                  </Button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
