import { useState } from "react";
import { CheckIcon, GitCompareArrowsIcon, MonitorSmartphoneIcon, Trash2Icon } from "lucide-react";
import { AnimatePresence, m } from "motion/react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { defaultPicks, differingFields, resolutionFor, type Side } from "@/lib/conflicts";
import { fade } from "@/lib/motion";
import { useStore } from "@/lib/store";
import type { ConflictView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "N tasks were changed on two devices" above the list, with a way to settle them. */
export function ConflictBanner() {
  const conflicts = useStore((s) => s.conflicts);
  return (
    <AnimatePresence initial={false}>
      {conflicts.length > 0 && (
        <m.div
          key="conflicts"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden"
        >
          <div className="flex items-center gap-3 border-b bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-300">
            <GitCompareArrowsIcon className="size-4 shrink-0" />
            <span className="flex-1">
              {conflicts.length === 1
                ? `“${title(conflicts[0])}” was changed on this device and another one.`
                : `${conflicts.length} tasks were changed on this device and another one.`}
            </span>
            <Button size="sm" variant="outline" onClick={() => useStore.getState().set({ conflictsOpen: true })}>
              Choose versions
            </Button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

function title(c: ConflictView): string {
  return (c.theirs ?? c.mine)?.summary || "Untitled task";
}

/** Settles tasks changed on two devices, one at a time. */
export function ConflictDialog() {
  const open = useStore((s) => s.conflictsOpen);
  const conflicts = useStore((s) => s.conflicts);
  const c = conflicts[0];
  return (
    <Dialog open={open && !!c} onOpenChange={(o) => useStore.getState().set({ conflictsOpen: o })}>
      <DialogContent className="max-h-[90vh] gap-5 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrowsIcon className="size-5 text-amber-500" />
            Changed on two devices
          </DialogTitle>
          <DialogDescription>
            {conflicts.length > 1 ? `${conflicts.length} tasks to look at. ` : ""}
            {c?.mine && c.theirs
              ? "Pick which version of each change to keep."
              : "One device deleted this task while the other changed it."}
          </DialogDescription>
        </DialogHeader>
        {/* The next conflict slides in once one is settled. */}
        <AnimatePresence mode="wait" initial={false}>
          {c && (
            <m.div
              key={c.id + c.at}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={fade}
            >
              <ConflictBody conflict={c} />
            </m.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function ConflictBody({ conflict: c }: { conflict: ConflictView }) {
  const tasks = useStore((s) => s.tasks);
  const lists = useStore((s) => s.lists);
  const [picks, setPicks] = useState<Record<string, Side>>(() => defaultPicks(c));
  const [busy, setBusy] = useState(false);
  const list = lists.find((l) => l.id === c.listId);

  const settle = async (p: Record<string, Side>) => {
    setBusy(true);
    await useStore.getState().resolveConflict(c.id, resolutionFor(c, p));
    setBusy(false);
  };
  const later = () => useStore.getState().set({ conflictsOpen: false });

  const heading = (
    <div className="flex min-w-0 items-center gap-2">
      {list && <span className="size-2.5 shrink-0 rounded-full" style={{ background: list.color ?? "var(--muted-foreground)" }} />}
      <span className="truncate font-medium">{title(c)}</span>
      {list && <span className="text-muted-foreground shrink-0 text-sm">{list.name}</span>}
    </div>
  );

  if (!c.mine || !c.theirs) {
    const deletedHere = !c.mine;
    return (
      <div className="grid gap-5">
        {heading}
        <div className="bg-muted/50 flex items-start gap-3 rounded-lg p-4 text-sm">
          {deletedHere ? (
            <Trash2Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          ) : (
            <MonitorSmartphoneIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          )}
          <p>
            {deletedHere
              ? "You deleted this task on this device, but it was changed on another device in the meantime."
              : "You changed this task on this device, but another device deleted it in the meantime."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={later} disabled={busy}>
            Decide later
          </Button>
          {deletedHere ? (
            <>
              <Button variant="outline" onClick={() => void settle({ all: "mine" })} disabled={busy}>
                <Trash2Icon /> Delete it
              </Button>
              <Button onClick={() => void settle({ all: "theirs" })} disabled={busy}>
                Keep the changed task
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => void settle({ all: "theirs" })} disabled={busy}>
                Let it go
              </Button>
              <Button onClick={() => void settle({ all: "mine" })} disabled={busy}>
                Restore my version
              </Button>
            </>
          )}
        </DialogFooter>
      </div>
    );
  }

  const mine = c.mine;
  const theirs = c.theirs;
  const fields = differingFields(mine, theirs);
  const all = (side: Side) => setPicks(Object.fromEntries(fields.map((f) => [f.key, side])));
  const ours = fields.filter((f) => picks[f.key] === "mine").length;
  const action =
    ours === fields.length ? "Keep this device’s version" : ours === 0 ? "Keep the other version" : "Keep my picks";

  return (
    <div className="grid gap-4">
      {heading}
      <div className="text-muted-foreground grid grid-cols-[1fr_1fr] gap-2 text-xs font-medium tracking-wide uppercase max-sm:hidden sm:pl-24">
        <button className="hover:text-foreground text-left transition-colors" onClick={() => all("mine")}>
          This device · <span className="normal-case">all</span>
        </button>
        <button className="hover:text-foreground text-left transition-colors" onClick={() => all("theirs")}>
          Other device · <span className="normal-case">all</span>
        </button>
      </div>
      <div className="grid gap-3">
        {fields.map((f, i) => (
          <div
            key={f.key}
            className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both grid items-start gap-2 duration-300 sm:grid-cols-[5.5rem_1fr_1fr]"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className="text-muted-foreground pt-2 text-sm">{f.label}</div>
            {(["mine", "theirs"] as const).map((side) => {
              const chosen = picks[f.key] === side;
              return (
                <button
                  key={side}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => setPicks((p) => ({ ...p, [f.key]: side }))}
                  className={cn(
                    "relative min-w-0 rounded-lg border px-3 py-2 pr-8 text-left text-sm transition-[background-color,border-color,box-shadow,opacity] duration-200",
                    chosen
                      ? "border-primary bg-primary/5 ring-primary/20 ring-2"
                      : "hover:bg-accent/60 opacity-70 hover:opacity-100",
                  )}
                >
                  <span className="text-muted-foreground mb-0.5 block text-[11px] sm:hidden">
                    {side === "mine" ? "This device" : "Other device"}
                  </span>
                  <span
                    className={cn("block break-words", f.key === "description" && "line-clamp-4 whitespace-pre-wrap")}
                  >
                    {f.show(side === "mine" ? mine : theirs, tasks)}
                  </span>
                  <CheckIcon
                    className={cn(
                      "text-primary absolute top-2.5 right-2.5 size-4 transition-[opacity,scale] duration-200 ease-(--ease-pop)",
                      chosen ? "scale-100 opacity-100" : "scale-50 opacity-0",
                    )}
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={later} disabled={busy}>
          Decide later
        </Button>
        <Button onClick={() => void settle(picks)} disabled={busy}>
          {action}
        </Button>
      </DialogFooter>
    </div>
  );
}
