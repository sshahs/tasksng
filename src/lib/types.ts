export type TaskStatus = "needs-action" | "in-process" | "completed" | "cancelled";

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
}

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
  categories?: string[];
  parentUid?: string | null;
  rrule?: string | null;
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
