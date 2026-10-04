import { toast } from "sonner";
import { create } from "zustand";

import { api, on } from "./api";
import { formatDue, parseDue } from "./dates";
import { getPref, setPref } from "./prefs";
import type {
  Account,
  ConnectArgs,
  NewTask,
  Snapshot,
  SyncStatus,
  Task,
  TaskList,
  TaskPatch,
} from "./types";

export type SmartView = "today" | "upcoming" | "important" | "all";
export type ViewId = SmartView | `list:${string}`;

export const SMART_VIEWS: { id: SmartView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "important", label: "Important" },
  { id: "all", label: "All tasks" },
];

export function listIdOf(view: ViewId): string | null {
  return view.startsWith("list:") ? view.slice(5) : null;
}

interface State {
  ready: boolean;
  revision: number;
  account: Account | null;
  lists: TaskList[];
  tasks: Record<string, Task>;
  lastSync: string | null;
  status: SyncStatus;

  view: ViewId;
  selectedId: string | null;
  search: string;
  showCompleted: boolean;
  collapsed: Record<string, boolean>;
  sidebarOpen: boolean;
  /** Bumped to ask the quick-add field to take focus. */
  focusQuickAdd: number;
  focusSearch: number;
  /** Increments to request the title field in the detail pane to focus. */
  focusTitle: number;
  paletteOpen: boolean;
  listDialog: { mode: "create" } | { mode: "edit"; list: TaskList } | null;
  settingsOpen: boolean;
  lastUndo: { token: number; label: string } | null;

  inflight: number;
  queued: Snapshot | null;
}

interface Actions {
  init(): Promise<void>;
  applySnapshot(s: Snapshot, force?: boolean): void;
  setView(view: ViewId): void;
  select(id: string | null): void;
  set(partial: Partial<State>): void;
  toggleCollapsed(uid: string): void;
  sync(manual?: boolean): Promise<void>;
  connect(args: ConnectArgs): Promise<void>;
  signOut(): Promise<void>;
  createTask(listId: string, input: NewTask): Promise<Task | null>;
  updateTask(id: string, patch: TaskPatch): Promise<void>;
  toggleComplete(id: string): Promise<void>;
  deleteTasks(ids: string[]): Promise<void>;
  undo(): Promise<void>;
  moveTask(id: string, listId: string): Promise<void>;
  createList(name: string, color: string | null): Promise<void>;
  updateList(id: string, name: string | null, color: string | null): Promise<void>;
  deleteList(id: string): Promise<void>;
  defaultListId(): string | null;
}

export type Store = State & Actions;

function sameTask(a: Task, b: Task): boolean {
  return (
    a.summary === b.summary &&
    a.description === b.description &&
    a.status === b.status &&
    a.completedAt === b.completedAt &&
    a.priority === b.priority &&
    a.due === b.due &&
    a.start === b.start &&
    a.parentUid === b.parentUid &&
    a.rrule === b.rrule &&
    a.listId === b.listId &&
    a.pending === b.pending &&
    a.modified === b.modified &&
    a.sortOrder === b.sortOrder &&
    a.categories.join("\u0000") === b.categories.join("\u0000")
  );
}

/** Keeps object identity for unchanged tasks so memoized rows don't re-render. */
function mergeTasks(prev: Record<string, Task>, next: Task[]): Record<string, Task> {
  const out: Record<string, Task> = {};
  for (const t of next) {
    const old = prev[t.id];
    out[t.id] = old && sameTask(old, t) ? old : t;
  }
  return out;
}

function optimistic(t: Task, p: TaskPatch): Task {
  const n: Task = { ...t, pending: true };
  if (p.summary !== undefined) n.summary = p.summary;
  if (p.description !== undefined) n.description = p.description ?? "";
  if (p.status !== undefined && !t.rrule) {
    n.status = p.status;
    n.completed = p.status === "completed" || p.status === "cancelled";
    n.completedAt = n.completed ? new Date().toISOString() : null;
  }
  if (p.priority !== undefined) n.priority = p.priority;
  if (p.due !== undefined) n.due = p.due;
  if (p.start !== undefined) n.start = p.start;
  if (p.categories !== undefined) n.categories = p.categories;
  if (p.parentUid !== undefined) n.parentUid = p.parentUid;
  if (p.rrule !== undefined) n.rrule = p.rrule;
  return n;
}

const initialStatus: SyncStatus = { state: "idle", message: null, lastSync: null, pending: 0 };
let initPromise: Promise<void> | null = null;

export const useStore = create<Store>()((set, get) => {
  /** Tracks mutations in flight so stale snapshots don't clobber optimistic UI. */
  async function mutate<T>(fn: () => Promise<T>): Promise<T> {
    set((s) => ({ inflight: s.inflight + 1 }));
    try {
      return await fn();
    } finally {
      set((s) => ({ inflight: s.inflight - 1 }));
      const { inflight, queued } = get();
      if (inflight === 0 && queued) {
        set({ queued: null });
        get().applySnapshot(queued);
      }
    }
  }

  function fail(e: unknown) {
    toast.error(e instanceof Error ? e.message : String(e));
  }

  function upsertTask(task: Task, revision: number) {
    set((s) => ({ tasks: { ...s.tasks, [task.id]: task }, revision: Math.max(s.revision, revision) }));
  }

  return {
    ready: false,
    revision: 0,
    account: null,
    lists: [],
    tasks: {},
    lastSync: null,
    status: initialStatus,
    view: getPref<ViewId>("view", "today"),
    selectedId: null,
    search: "",
    showCompleted: getPref("show-completed", false),
    collapsed: getPref<Record<string, boolean>>("collapsed", {}),
    sidebarOpen: getPref("sidebar", true),
    focusQuickAdd: 0,
    focusSearch: 0,
    focusTitle: 0,
    paletteOpen: false,
    listDialog: null,
    settingsOpen: false,
    lastUndo: null,
    inflight: 0,
    queued: null,

    init() {
      initPromise ??= (async () => {
      const [snapshot, status] = await Promise.all([api.getSnapshot(), api.getStatus()]);
      get().applySnapshot(snapshot, true);
      set({ status, ready: true });
      // A view pointing at a list that no longer exists falls back to Today.
      const lid = listIdOf(get().view);
      if (lid && !snapshot.lists.some((l) => l.id === lid)) set({ view: "today" });

      await on<Snapshot>("snapshot", (s) => get().applySnapshot(s));
      await on<SyncStatus>("sync-status", (status) => set({ status }));
      await on<string[]>("notices", (notices) => notices.forEach((n) => toast.warning(n, { duration: 8000 })));
      })();
      return initPromise;
    },

    applySnapshot(s, force = false) {
      const state = get();
      if (!force) {
        if (s.revision < state.revision) return;
        if (state.inflight > 0) {
          set({ queued: s });
          return;
        }
      }
      const tasks = mergeTasks(state.tasks, s.tasks);
      const selectedId = state.selectedId && tasks[state.selectedId] ? state.selectedId : null;
      set({
        revision: s.revision,
        account: s.account,
        lists: [...s.lists].sort(
          (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name),
        ),
        tasks,
        lastSync: s.lastSync,
        selectedId,
      });
    },

    setView(view) {
      setPref("view", view);
      set({ view, selectedId: null, search: "" });
    },

    select(id) {
      set({ selectedId: id });
    },

    set(partial) {
      if (partial.showCompleted !== undefined) setPref("show-completed", partial.showCompleted);
      if (partial.sidebarOpen !== undefined) setPref("sidebar", partial.sidebarOpen);
      set(partial);
    },

    toggleCollapsed(uid) {
      const collapsed = { ...get().collapsed };
      if (collapsed[uid]) delete collapsed[uid];
      else collapsed[uid] = true;
      setPref("collapsed", collapsed);
      set({ collapsed });
    },

    async sync(manual = false) {
      const { account, status } = get();
      if (!account || status.state === "syncing") return;
      try {
        const out = await api.syncNow();
        get().applySnapshot(out.snapshot);
        out.notices.forEach((n) => toast.warning(n, { duration: 8000 }));
        if (manual && out.error) {
          if (get().status.state === "offline") {
            toast.warning("Can't reach your Baikal server", {
              description: "Your changes are kept on this PC and sync automatically when it's back.",
            });
          } else {
            toast.error(out.error);
          }
        }
      } catch (e) {
        if (manual) fail(e);
      }
    },

    async connect(args) {
      const out = await api.connect(args);
      get().applySnapshot(out.snapshot, true);
      if (out.error) toast.error(out.error);
      const first = out.snapshot.lists.find((l) => !l.readOnly);
      if (first && !getPref<string | null>("default-list", null)) setPref("default-list", first.id);
    },

    async signOut() {
      try {
        const snapshot = await api.signOut();
        get().applySnapshot(snapshot, true);
        set({ selectedId: null, view: "today" });
      } catch (e) {
        fail(e);
      }
    },

    defaultListId() {
      const { lists, view } = get();
      const writable = lists.filter((l) => !l.readOnly);
      const fromView = listIdOf(view);
      if (fromView && writable.some((l) => l.id === fromView)) return fromView;
      const saved = getPref<string | null>("default-list", null);
      if (saved && writable.some((l) => l.id === saved)) return saved;
      return writable[0]?.id ?? null;
    },

    async createTask(listId, input) {
      try {
        const res = await mutate(() => api.createTask(listId, input));
        upsertTask(res.task, res.revision);
        return res.task;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async updateTask(id, patch) {
      const before = get().tasks[id];
      if (!before) return;
      set((s) => ({ tasks: { ...s.tasks, [id]: optimistic(before, patch) } }));
      try {
        const res = await mutate(() => api.updateTask(id, patch));
        upsertTask(res.task, res.revision);
        if (res.advancedTo) {
          const due = parseDue(res.advancedTo);
          toast.success(`Repeats — next due ${due ? formatDue(due) : res.advancedTo}`);
        }
      } catch (e) {
        set((s) => ({ tasks: { ...s.tasks, [id]: before } }));
        fail(e);
      }
    },

    async toggleComplete(id) {
      const t = get().tasks[id];
      if (!t) return;
      await get().updateTask(id, { status: t.completed ? "needs-action" : "completed" });
    },

    async deleteTasks(ids) {
      const { tasks } = get();
      const victims = ids.map((id) => tasks[id]).filter(Boolean);
      if (!victims.length) return;
      const label = victims.length === 1 ? `“${victims[0].summary || "Untitled"}”` : `${victims.length} tasks`;
      try {
        const res = await mutate(() => api.deleteTasks(ids));
        get().applySnapshot(res.snapshot, true);
        set({ lastUndo: { token: res.token, label } });
        toast(`Deleted ${label}`, {
          action: { label: "Undo", onClick: () => void get().undo() },
          duration: 6000,
        });
      } catch (e) {
        fail(e);
      }
    },

    async undo() {
      const u = get().lastUndo;
      if (!u) return;
      set({ lastUndo: null });
      try {
        const snapshot = await mutate(() => api.undoDelete(u.token));
        get().applySnapshot(snapshot, true);
        toast.success(`Restored ${u.label}`);
      } catch (e) {
        fail(e);
      }
    },

    async moveTask(id, listId) {
      const uid = get().tasks[id]?.uid;
      const wasSelected = get().selectedId === id;
      try {
        const snapshot = await mutate(() => api.moveTask(id, listId));
        get().applySnapshot(snapshot, true);
        // The task gets a new id in the target list; keep it selected.
        if (wasSelected && uid) {
          const moved = snapshot.tasks.find((t) => t.uid === uid && t.listId === listId);
          if (moved) set({ selectedId: moved.id });
        }
      } catch (e) {
        fail(e);
      }
    },

    async createList(name, color) {
      const known = new Set(get().lists.map((l) => l.id));
      const snapshot = await api.createList(name, color);
      get().applySnapshot(snapshot, true);
      const added = snapshot.lists.find((l) => !known.has(l.id));
      if (added) get().setView(`list:${added.id}`);
    },

    async updateList(id, name, color) {
      const snapshot = await api.updateList(id, name, color);
      get().applySnapshot(snapshot, true);
    },

    async deleteList(id) {
      try {
        const snapshot = await api.deleteList(id);
        get().applySnapshot(snapshot, true);
        if (listIdOf(get().view) === id) get().setView("today");
      } catch (e) {
        fail(e);
      }
    },
  };
});
