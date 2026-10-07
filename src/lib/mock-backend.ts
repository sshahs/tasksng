/**
 * In-memory stand-in for the Rust backend, used only when the UI runs in a
 * normal browser via `npm run dev` (never bundled into the desktop app).
 */
import { addDays, format } from "date-fns";

import type {
  CalEvent,
  ConflictView,
  EventsResult,
  NewTask,
  Resolution,
  Settings,
  SettingsPatch,
  SettingsView,
  Snapshot,
  SyncStatus,
  Task,
  TaskList,
  TaskPatch,
  TaskUpdate,
  TaskVersion,
  VersionSource,
} from "./types";

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
      planned: null,
      plannedMinutes: null,
      snoozedUntil: null,
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
  // `?many=500` adds that many tasks to try the app with a big list.
  const many = Number(new URLSearchParams(location.search).get("many")) || 0;
  for (let i = 0; i < many; i++) {
    tasks.push(mk([P, W, G][i % 3], { summary: `Generated task ${i + 1}`, priority: [0, 1, 5, 9][i % 4], due: i % 5 ? null : day(i % 9) }));
  }
  // Something already planned today, at 11:00 local time.
  const plannedTask = tasks.find((t) => t.summary === "Draft announcement blog post");
  if (plannedTask) {
    const at = new Date();
    at.setHours(11, 0, 0, 0);
    Object.assign(plannedTask, { planned: at.toISOString().replace(/\.\d{3}Z$/, "Z"), plannedMinutes: 60 });
  }
  /** Demo calendar events for a day. */
  const eventsFor = (from: Date): CalEvent[] => {
    const at = (h: number, m = 0) => {
      const d = new Date(from);
      d.setHours(h, m, 0, 0);
      return d.toISOString().replace(/\.\d{3}Z$/, "Z");
    };
    const weekday = from.getDay() % 6 !== 0;
    const ev = (id: string, title: string, start: string, end: string, color: string, location: string | null = null): CalEvent => ({
      id: `/dav.php/calendars/demo/default/${id}-${from.getDate()}.ics`,
      calendarId: "/dav.php/calendars/demo/default/",
      title,
      start,
      end,
      allDay: false,
      location,
      color,
    });
    const out: CalEvent[] = [];
    if (weekday) out.push(ev("standup", "Stand-up", at(9, 30), at(9, 45), "#8B5CF6", "Video call"));
    out.push(ev("lunch", "Lunch with Sam", at(12, 30), at(13, 30), "#10B981", "Café Nero"));
    if (weekday) out.push(ev("review", "Design review", at(15), at(16), "#8B5CF6"), ev("1on1", "1:1 with Alex", at(15, 30), at(16), "#F59E0B"));
    if (from.getDay() === 5) {
      out.unshift({ ...ev("bday", "Mum’s birthday", format(from, "yyyy-MM-dd"), format(addDays(from, 1), "yyyy-MM-dd"), "#EC4899"), allDay: true });
    }
    return out;
  };

  // `?conflict` pretends "Call grandma" was also changed on another device.
  let conflicts: ConflictView[] = [];
  if (new URLSearchParams(location.search).has("conflict")) {
    const t = tasks.find((x) => x.summary === "Call grandma")!;
    const mine = { ...t, summary: "Call grandma about Sunday", priority: 1 };
    Object.assign(t, { due: `${day(1)}T11:00:00`, categories: ["family"] });
    conflicts = [{ id: t.id, listId: t.listId, mine, theirs: t, at: new Date().toISOString() }];
  }
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
    conflicts: signedIn ? conflicts : [],
  });
  const bump = () => revision++;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const find = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error("This task no longer exists");
    return t;
  };
  /** Versions per task id, oldest first, like the real store keeps them. */
  const history = new Map<string, TaskVersion[]>();
  const record = (before: Task | null, after: Task, source: VersionSource) => {
    const list = history.get(after.id) ?? [];
    if (!list.length && before) list.push({ at: before.modified ?? before.created ?? new Date().toISOString(), source: "earlier", task: before });
    const last = list[list.length - 1];
    const now = new Date().toISOString();
    if (last && source === "here" && (last.source === "here" || last.source === "created") && Date.now() - new Date(last.at).getTime() < 180_000) {
      list[list.length - 1] = { ...last, at: last.source === "here" ? now : last.at, task: after };
    } else {
      list.push({ at: now, source, task: after });
    }
    history.set(after.id, list.slice(-25));
  };
  {
    // Some past for the launch task, so History has something to show.
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    history.set(launch.id, [
      { at: ago(72), source: "earlier", task: { ...launch, summary: "Prepare product launch", priority: 5, due: day(5), categories: [] } },
      { at: ago(50), source: "elsewhere", task: { ...launch, summary: "Prepare Q4 product launch", priority: 5, due: day(3), categories: [] } },
      { at: ago(26), source: "here", task: { ...launch, due: day(3), description: "Draft the announcement first." } },
      { at: ago(3), source: "elsewhere", task: launch },
    ]);
  }

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
    if (p.planned !== undefined) next.planned = p.planned;
    if (p.plannedMinutes !== undefined) next.plannedMinutes = p.plannedMinutes;
    if (p.snoozedUntil !== undefined) next.snoozedUntil = p.snoozedUntil;
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
      record(null, t, "created");
      bump();
      return { task: t, revision, advancedTo: null };
    },
    update_task: (a) => {
      const t = find(a.id as string);
      const { next, advancedTo } = applyPatch(t, a.patch as TaskPatch);
      tasks = tasks.map((x) => (x.id === t.id ? next : x));
      record(t, next, "here");
      bump();
      return { task: next, revision, advancedTo };
    },
    update_tasks: (a) => {
      for (const u of a.updates as TaskUpdate[]) {
        const t = find(u.id);
        const { next } = applyPatch(t, u.patch);
        tasks = tasks.map((x) => (x.id === t.id ? next : x));
        record(t, next, "here");
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
    task_history: (a) => [...(history.get(a.id as string) ?? [])].reverse(),
    get_events: async (a) => {
      await sleep(250);
      const from = new Date(String(a.from));
      return { events: signedIn ? eventsFor(from) : [], fetchedAt: new Date().toISOString(), error: null } satisfies EventsResult;
    },
    resolve_conflict: (a) => {
      const c = conflicts.find((x) => x.id === a.id);
      if (!c) throw new Error("This conflict was already settled");
      const r = a.resolution as Resolution;
      const i = tasks.findIndex((t) => t.id === c.id);
      if (r.keep === "mine" && c.mine) {
        if (i >= 0) tasks[i] = c.mine;
        else tasks.push(c.mine);
      } else if (r.keep === "mine") {
        tasks = tasks.filter((t) => t.id !== c.id);
      } else if (r.keep === "merge" && i >= 0) {
        const { patch } = r;
        tasks[i] = { ...tasks[i], ...(patch as Partial<Task>), completed: (patch.status ?? tasks[i].status) === "completed" };
      }
      conflicts = conflicts.filter((x) => x !== c);
      bump();
      return snapshot();
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
      const { launchAtLogin: launch, ...patch } = a.patch as SettingsPatch;
      settings = { ...settings, ...patch };
      if (launch !== undefined) launchAtLogin = launch;
      return settingsView();
    },
    suspend_shortcut: () => null,
    open_link: (a) => {
      window.open(String(a.url), "_blank", "noopener");
      return null;
    },
    reminder_action: () => null,
    test_notification: () => {
      throw "Notifications are only available in the desktop app";
    },
    hide_quick_add: () => null,
    quit_app: () => null,
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
