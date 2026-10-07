export type TaskStatus = "needs-action" | "in-process" | "completed" | "cancelled";

/**
 * A reminder (an iCalendar VALARM): either a fixed time (UTC) or an offset
 * in seconds from the due (or start) date; negative means before.
 */
export type Reminder = { at: string } | { offset: number; related: "due" | "start" };

export interface Task {
  /** Resource path on the server – unique per task. */
  id: string;
  uid: string;
  listId: string;
  summary: string;
  description: string;
  status: TaskStatus;
  completed: boolean;
  completedAt: string | null;
  /** 0 = none, 1 (highest) … 9 (lowest) */
  priority: number;
  /** `YYYY-MM-DD` (all day), `YYYY-MM-DDTHH:MM:SSZ` (UTC) or floating local time. */
  due: string | null;
  start: string | null;
  categories: string[];
  parentUid: string | null;
  rrule: string | null;
  created: string | null;
  modified: string | null;
  sortOrder: number | null;
  reminders: Reminder[];
  /** Planned for this time in the day planner (UTC instant). */
  planned: string | null;
  /** How long it is planned for. */
  plannedMinutes: number | null;
  /** Snoozed: hidden until this moment (UTC instant). */
  snoozedUntil: string | null;
  /** Not yet saved to the server. */
  pending: boolean;
}

export interface TaskList {
  id: string;
  name: string;
  color: string | null;
  order: number | null;
  readOnly: boolean;
}

export interface Account {
  serverUrl: string;
  username: string;
  principalUrl: string;
  homeUrl: string;
  acceptInvalidCerts: boolean;
}

export interface Snapshot {
  revision: number;
  account: Account | null;
  lists: TaskList[];
  tasks: Task[];
  lastSync: string | null;
  pending: number;
  conflicts: ConflictView[];
}

/** A calendar event shown in the day planner (read only). */
export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  /** `YYYY-MM-DD` for all-day events, otherwise a UTC instant. */
  start: string;
  /** Exclusive. */
  end: string;
  allDay: boolean;
  location: string | null;
  color: string | null;
}

export interface EventsResult {
  events: CalEvent[];
  fetchedAt: string | null;
  /** Why they couldn't be refreshed (they come from the cache then). */
  error: string | null;
}

/** A task changed on this device and another one (or deleted on one of them). */
export interface ConflictView {
  id: string;
  listId: string;
  /** This device's version; null when it was deleted here. */
  mine: Task | null;
  /** The server's version; null when another device deleted it. */
  theirs: Task | null;
  at: string;
}

/** How a conflict is settled: one side, or the other side with some of our fields. */
export type Resolution = { keep: "theirs" } | { keep: "mine" } | { keep: "merge"; patch: TaskPatch };

export type SyncState = "idle" | "syncing" | "offline" | "error" | "auth-required" | "signed-out";

export interface SyncStatus {
  state: SyncState;
  message: string | null;
  lastSync: string | null;
  pending: number;
}

export interface NewTask {
  summary: string;
  description?: string | null;
  priority?: number | null;
  due?: string | null;
  start?: string | null;
  categories?: string[];
  parentUid?: string | null;
  rrule?: string | null;
  reminders?: Reminder[];
  sortOrder?: number | null;
}

export interface TaskPatch {
  summary?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: number;
  due?: string | null;
  start?: string | null;
  categories?: string[];
  parentUid?: string | null;
  rrule?: string | null;
  sortOrder?: number;
  reminders?: Reminder[];
  planned?: string | null;
  plannedMinutes?: number | null;
  snoozedUntil?: string | null;
}

export interface TaskUpdate {
  id: string;
  patch: TaskPatch;
}

export interface TaskResult {
  task: Task;
  revision: number;
  advancedTo: string | null;
}

export interface SyncOutcome {
  snapshot: Snapshot;
  notices: string[];
  error: string | null;
}

export interface DeleteResult {
  token: number;
  snapshot: Snapshot;
}

export interface ConnectArgs {
  serverUrl: string;
  username: string;
  password: string;
  acceptInvalidCerts: boolean;
}

export interface Settings {
  closeToTray: boolean;
  reminders: boolean;
  /** Seconds relative to the due time for timed tasks without reminders; null = off. */
  defaultReminder: number | null;
  /** e.g. "Super+Alt+N"; null = off. */
  quickAddShortcut: string | null;
  trayHintShown: boolean;
}

/** A change to settings: only the fields given are changed. */
export type SettingsPatch = Partial<Omit<Settings, "trayHintShown">> & { launchAtLogin?: boolean };

export interface SettingsView extends Settings {
  launchAtLogin: boolean;
  shortcutError: string | null;
  /** Reminders appear as system notifications (otherwise inside the app). */
  nativeNotifications: boolean;
  platform?: Platform;
}

/** What the system supports, for the right wording in Settings. */
export interface Platform {
  os: "windows" | "linux" | "macos" | "android" | "web" | (string & {});
  /** How TasksNG was installed, which decides how it is updated. */
  installKind: "windows" | "nix" | "appimage" | "system" | "android" | "server";
  /** Global shortcuts can't be registered (Wayland): bind `tasksng --quick-add` instead. */
  wayland: boolean;
  /** A tray icon is visible somewhere. */
  tray: boolean;
  notificationActions: boolean;
  autostartError: string | null;
}

export interface DueReminder {
  uid: string;
  id: string;
  title: string;
  body: string;
}
