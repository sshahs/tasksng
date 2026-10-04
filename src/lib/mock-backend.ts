/**
 * In-memory stand-in for the Rust backend, used only when the UI runs in a
 * normal browser via `npm run dev` (never bundled into the desktop app).
 */
import { addDays, format } from "date-fns";

import type { NewTask, Settings, SettingsView, Snapshot, SyncStatus, Task, TaskList, TaskPatch, TaskUpdate } from "./types";

type Handler = (payload: never) => void;

export function createMockBackend() {
  const listeners = new Map<string, Set<Handler>>();
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload as never));

  let revision = 1;
  let signedIn = !location.search.includes("setup");
  const day = (n: number) => format(addDays(new Date(), n), "yyyy-MM-dd");
  const lists: TaskList[] = [
    { id: "/dav.php/calendars/demo/personal/", name: "Personal", color: "#3B82F6", order: 1, readOnly: false },
    { id: "/dav.php/calendars/demo/work/", name: "Work", color: "#F59E0B", order: 2, readOnly: false },
    { id: "/dav.php/calendars/demo/groceries/", name: "Groceries", color: "#10B981", order: 3, readOnly: false },
  ];
  const [P, W, G] = lists.map((l) => l.id);
  let n = 0;
  const mk = (listId: string, p: Partial<Task>): Task => {
    n++;
    const uid = `DEMO-${n}`;
    return {
      id: `${listId}${uid}.ics`,
      uid,
      listId,
      summary: "",
      description: "",
      status: "needs-action",
      completed: false,
      completedAt: null,
      priority: 0,
      due: null,
      start: null,
      categories: [],
      parentUid: null,
      rrule: null,
      created: new Date(Date.now() - (100 - n) * 60000).toISOString(),
      modified: null,
      sortOrder: null,
      reminders: [],
      pending: false,
      ...p,
    };
  };
  const launch = mk(W, { summary: "Prepare Q4 product launch", priority: 1, due: day(2), categories: ["launch"] });
  let tasks: Task[] = [
    mk(P, { summary: "Renew car insurance", due: day(-2), priority: 1, categories: ["admin"] }),
    mk(P, {
      summary: "Call grandma",
      due: `${day(0)}T18:00:00`,
      description: "Ask about the recipe for **plum cake** 🍰\n\n- [x] Find her new number\n- [ ] Ask about Sunday\n\nRecipe ideas: https://www.bbc.co.uk/food",
      reminders: [{ offset: -900, related: "due" }],
    }),
    mk(P, { summary: "Water the plants", due: day(0), rrule: "FREQ=WEEKLY", categories: ["home"] }),
    mk(P, { summary: "Book dentist appointment", due: day(5) }),
    mk(P, { summary: "Plan winter holiday", start: day(3), categories: ["travel"] }),
    mk(P, { summary: "Read “The Pragmatic Programmer”", categories: ["books"] }),
    launch,
    mk(W, { summary: "Draft announcement blog post", parentUid: launch.uid, due: day(1) }),
    mk(W, { summary: "Review pricing page copy", parentUid: launch.uid, completed: true, status: "completed", completedAt: new Date().toISOString() }),
    mk(W, { summary: "Schedule press briefing", parentUid: launch.uid, priority: 5, status: "in-process" }),
    mk(W, { summary: "Submit timesheet", due: day(3), rrule: "FREQ=MONTHLY;BYDAY=-1FR", categories: ["admin"] }),
    mk(W, { summary: "Weekly 1:1 notes", due: `${day(0)}T14:30:00`, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" }),
    mk(W, { summary: "Expense report for September", due: day(-1), priority: 5 }),
    mk(W, { summary: "Clean up CI pipeline", priority: 9, categories: ["eng"] }),
    mk(G, { summary: "Oat milk" }),
    mk(G, { summary: "Coffee beans", priority: 1 }),
    mk(G, { summary: "Basil" }),
    mk(G, { summary: "Sourdough bread", completed: true, status: "completed", completedAt: new Date().toISOString() }),
  ];
  const trash = new Map<number, Task[]>();
  let token = 0;
  let lastSync: string | null = new Date().toISOString();
  let settings: Settings = {
    closeToTray: true,
    reminders: true,
    defaultReminder: 0,
    quickAddShortcut: "Super+Alt+N",
    trayHintShown: false,
  };
  let launchAtLogin = false;
  const settingsView = (): SettingsView => ({ ...settings, launchAtLogin, shortcutError: null, nativeNotifications: false });
  let status: SyncStatus = { state: "idle", message: null, lastSync, pending: 0 };

  const account = () =>
    signedIn
      ? { serverUrl: "https://dav.example.com", username: "demo", principalUrl: "", homeUrl: "", acceptInvalidCerts: false }
      : null;
  const snapshot = (): Snapshot => ({
    revision,
    account: account(),
    lists: signedIn ? lists : [],
    tasks: signedIn ? tasks : [],
    lastSync,
    pending: 0,
  });
  const bump = () => revision++;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const find = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error("This task no longer exists");
    return t;
  };
  const descendants = (t: Task): Task[] => {
    const kids = tasks.filter((k) => k.parentUid === t.uid && k.listId === t.listId);
    return [t, ...kids.flatMap(descendants)];
  };

  const applyPatch = (t: Task, p: TaskPatch): { next: Task; advancedTo: string | null } => {
    const next: Task = { ...t, modified: new Date().toISOString() };
    if (p.summary !== undefined) next.summary = p.summary;
    if (p.description !== undefined) next.description = p.description ?? "";
    if (p.priority !== undefined) next.priority = p.priority;
    if (p.due !== undefined) next.due = p.due;
    if (p.start !== undefined) next.start = p.start;
    if (p.categories !== undefined) next.categories = p.categories;
    if (p.parentUid !== undefined) next.parentUid = p.parentUid;
    if (p.sortOrder !== undefined) next.sortOrder = p.sortOrder;
    if (p.reminders !== undefined) next.reminders = p.reminders;
    if (p.rrule !== undefined) {
      next.rrule = p.rrule;
      if (p.rrule && !next.due) next.due = day(0);
    }
    let advancedTo: string | null = null;
    if (p.status !== undefined) {
      if ((p.status === "completed" || p.status === "cancelled") && next.rrule && next.due) {
        const d = next.due.length === 10 ? next.due : next.due.slice(0, 10);
        const step = next.rrule.includes("DAILY") || next.rrule.includes("BYDAY") ? 1 : next.rrule.includes("MONTHLY") ? 30 : 7;
        next.due = format(addDays(new Date(d), step), "yyyy-MM-dd");
        next.status = "needs-action";
        advancedTo = next.due;
      } else {
        next.status = p.status;
        next.completed = p.status === "completed" || p.status === "cancelled";
        next.completedAt = next.completed ? new Date().toISOString() : null;
      }
    }
    return { next, advancedTo };
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    get_snapshot: () => snapshot(),
    get_status: () => (signedIn ? status : { ...status, state: "signed-out" }),
    connect: async (a) => {
      await sleep(600);
      const args = a.args as { password: string };
      if (args.password !== "demo") throw "The server rejected the username or password";
      signedIn = true;
      bump();
      return { snapshot: snapshot(), notices: [], error: null };
    },
    sign_out: () => {
      signedIn = false;
      bump();
      return snapshot();
    },
    sync_now: async () => {
      status = { ...status, state: "syncing" };
      emit("sync-status", status);
      await sleep(500);
      lastSync = new Date().toISOString();
      status = { state: "idle", message: null, lastSync, pending: 0 };
      emit("sync-status", status);
      return { snapshot: snapshot(), notices: [], error: null };
    },
    create_task: (a) => {
      const input = a.task as NewTask;
      const t = mk(a.listId as string, {
        summary: input.summary.trim(),
        description: input.description ?? "",
        priority: input.priority ?? 0,
        due: input.due ?? null,
        start: input.start ?? null,
        categories: input.categories ?? [],
        parentUid: input.parentUid ?? null,
        rrule: input.rrule ?? null,
        reminders: input.reminders ?? [],
        sortOrder: input.sortOrder ?? null,
      });
      tasks = [...tasks, t];
      bump();
      return { task: t, revision, advancedTo: null };
    },
    update_task: (a) => {
      const t = find(a.id as string);
      const { next, advancedTo } = applyPatch(t, a.patch as TaskPatch);
      tasks = tasks.map((x) => (x.id === t.id ? next : x));
      bump();
      return { task: next, revision, advancedTo };
    },
    update_tasks: (a) => {
      for (const u of a.updates as TaskUpdate[]) {
        const t = find(u.id);
        const { next } = applyPatch(t, u.patch);
        tasks = tasks.map((x) => (x.id === t.id ? next : x));
      }
      bump();
      return snapshot();
    },
    move_task: (a) => {
      const t = find(a.id as string);
      const target = a.listId as string;
      const moving = new Set(descendants(t).map((x) => x.id));
      tasks = tasks.map((x) =>
        moving.has(x.id)
          ? { ...x, listId: target, id: `${target}${x.uid}.ics`, parentUid: x.id === t.id ? null : x.parentUid }
          : x,
      );
      bump();
      return snapshot();
    },
    delete_tasks: (a) => {
      const ids = a.ids as string[];
      const victims = ids.flatMap((id) => descendants(find(id)));
      const gone = new Set(victims.map((v) => v.id));
      tasks = tasks.filter((x) => !gone.has(x.id));
      trash.set(++token, victims);
      bump();
      return { token, snapshot: snapshot() };
    },
    undo_delete: (a) => {
      tasks = [...tasks, ...(trash.get(a.token as number) ?? [])];
      bump();
      return snapshot();
    },
    create_list: async (a) => {
      await sleep(300);
      const name = String(a.name);
      lists.push({ id: `/dav.php/calendars/demo/${crypto.randomUUID()}/`, name, color: (a.color as string) ?? null, order: null, readOnly: false });
      bump();
      return snapshot();
    },
    update_list: async (a) => {
      await sleep(200);
      const l = lists.find((x) => x.id === a.id);
      if (l) {
        if (a.name) l.name = String(a.name);
        if (a.color) l.color = String(a.color);
      }
      bump();
      return snapshot();
    },
    get_settings: () => settingsView(),
    update_settings: (a) => {
      settings = a.settings as Settings;
      launchAtLogin = !!a.launchAtLogin;
      return settingsView();
    },
    suspend_shortcut: () => null,
    open_link: (a) => {
      window.open(String(a.url), "_blank", "noopener");
      return null;
    },
    reminder_action: () => null,
    test_notification: () => {
      throw "Windows notifications are only available in the desktop app";
    },
    hide_quick_add: () => null,
    window_ready: () => null,
    delete_list: async (a) => {
      await sleep(200);
      const i = lists.findIndex((x) => x.id === a.id);
      if (i >= 0) lists.splice(i, 1);
      tasks = tasks.filter((t) => t.listId !== a.id);
      bump();
      return snapshot();
    },
  };

  return {
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      const h = handlers[cmd];
      if (!h) throw new Error(`mock: unknown command ${cmd}`);
      return (await h(args)) as T;
    },
    async listen<T>(event: string, handler: (payload: T) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as Handler);
      listeners.set(event, set);
      return () => set.delete(handler as Handler);
    },
  };
}
