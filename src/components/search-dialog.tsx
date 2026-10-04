import { useEffect, useMemo, useState } from "react";

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
import { FILTER_HELP, matchesQuery, parseQuery } from "@/lib/search";
import { useStore } from "@/lib/store";

/** Saves (or edits) a search shown in the sidebar. */
export function SearchDialog() {
  const dialog = useStore((s) => s.searchDialog);
  const tasks = useStore((s) => s.tasks);
  const lists = useStore((s) => s.lists);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!dialog) return;
    if (dialog.mode === "edit") {
      setName(dialog.search.name);
      setQuery(dialog.search.query);
    } else {
      setQuery(dialog.query.trim());
      setName(dialog.query.trim());
    }
  }, [dialog]);

  const matching = useMemo(() => {
    if (!dialog) return 0;
    const q = parseQuery(query);
    const ctx = { listNames: new Map(lists.map((l) => [l.id, l.name])), now: new Date() };
    return Object.values(tasks).filter((t) => (q.wantsDone || !t.completed) && matchesQuery(t, q, ctx)).length;
  }, [dialog, query, tasks, lists]);

  const close = () => useStore.getState().set({ searchDialog: null });
  const save = () => {
    if (!dialog || !query.trim()) return;
    const s = useStore.getState();
    if (dialog.mode === "edit") s.updateSavedSearch(dialog.search.id, name, query);
    else {
      s.saveSearch(name, query);
      s.set({ search: "" });
    }
    close();
  };

  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialog?.mode === "edit" ? "Edit saved search" : "Save search"}</DialogTitle>
          <DialogDescription>Saved searches appear in the sidebar and stay up to date.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="search-name">Name</Label>
            <Input id="search-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Urgent work" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="search-query">Search</Label>
            <Input
              id="search-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="#work !1 due:week"
              className="font-mono text-sm"
            />
            <p className="text-muted-foreground text-xs">
              {matching === 1 ? "1 task matches" : `${matching} tasks match`} right now.
            </p>
          </div>
          <div className="bg-muted/40 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border p-3 text-xs">
            {FILTER_HELP.map(([k, v]) => (
              <div key={k} className="contents">
                <code className="font-mono">{k}</code>
                <span className="text-muted-foreground">{v}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!query.trim()}>
              {dialog?.mode === "edit" ? "Save" : "Add to sidebar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Renames a tag on every task that carries it. */
export function TagDialog() {
  const tag = useStore((s) => s.tagDialog);
  const count = useStore((s) =>
    s.tagDialog ? Object.values(s.tasks).filter((t) => t.categories.some((c) => c.toLowerCase() === s.tagDialog!.toLowerCase())).length : 0,
  );
  const [name, setName] = useState("");

  useEffect(() => {
    if (tag) setName(tag);
  }, [tag]);

  const close = () => useStore.getState().set({ tagDialog: null });
  const clean = name.trim().replace(/^#/, "").replace(/\s+/g, "-");

  return (
    <Dialog open={tag !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename #{tag}</DialogTitle>
          <DialogDescription>
            Changes the tag on {count === 1 ? "1 task" : `${count} tasks`}, everywhere they sync.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (tag && clean) void useStore.getState().renameTag(tag, clean);
            close();
          }}
        >
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} aria-label="New tag name" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!clean || clean === tag}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
