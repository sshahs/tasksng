import { useEffect, useState } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export const LIST_COLORS = [
  "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899", "#EF4444", "#F97316",
  "#F59E0B", "#84CC16", "#10B981", "#14B8A6", "#06B6D4", "#64748B",
];

export function ListDialog() {
  const dialog = useStore((s) => s.listDialog);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LIST_COLORS[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    if (dialog.mode === "edit") {
      setName(dialog.list.name);
      setColor(dialog.list.color ?? LIST_COLORS[0]);
    } else {
      setName("");
      setColor(LIST_COLORS[Math.floor(Math.random() * LIST_COLORS.length)]);
    }
  }, [dialog]);

  const close = () => useStore.getState().set({ listDialog: null });

  const save = async () => {
    if (!dialog || !name.trim()) return;
    setBusy(true);
    try {
      if (dialog.mode === "create") {
        await useStore.getState().createList(name.trim(), color);
      } else {
        const l = dialog.list;
        await useStore.getState().updateList(
          l.id,
          name.trim() !== l.name ? name.trim() : null,
          color !== l.color ? color : null,
        );
      }
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialog?.mode === "edit" ? "Edit list" : "New list"}</DialogTitle>
          <DialogDescription>
            {dialog?.mode === "edit"
              ? "Changes are saved to your Baikal server."
              : "Creates a new task calendar on your Baikal server."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="list-name">Name</Label>
            <Input
              id="list-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Groceries"
            />
          </div>
          <div className="grid gap-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {LIST_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "ring-offset-background flex size-7 items-center justify-center rounded-full transition-transform hover:scale-110",
                    color.toUpperCase() === c && "ring-ring ring-2 ring-offset-2",
                  )}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                >
                  {color.toUpperCase() === c && <CheckIcon className="size-4 text-white" />}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2Icon className="animate-spin" />}
              {dialog?.mode === "edit" ? "Save" : "Create list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
