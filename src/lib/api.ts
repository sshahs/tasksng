import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  ConnectArgs,
  DeleteResult,
  NewTask,
  Snapshot,
  SyncOutcome,
  SyncStatus,
  TaskPatch,
  TaskResult,
} from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, handler: (payload: T) => void) => Promise<UnlistenFn>;

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let backend: Promise<{ invoke: Invoke; listen: Listen }> | null = null;

function getBackend() {
  if (!backend) {
    backend = (async () => {
      if (isTauri) {
        return {
          invoke: tauriInvoke as Invoke,
          listen: ((event, handler) => tauriListen(event, (e) => handler(e.payload as never))) as Listen,
        };
      }
      if (import.meta.env.DEV) {
        // Browser preview (npm run dev): an in-memory backend with demo data.
        const mock = await import("./mock-backend");
        return mock.createMockBackend();
      }
      throw new Error("TasksNG must run inside the desktop app");
    })();
  }
  return backend;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = await getBackend();
  try {
    return await b.invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

export async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  const b = await getBackend();
  return b.listen<T>(event, handler);
}

export const api = {
  getSnapshot: () => call<Snapshot>("get_snapshot"),
  getStatus: () => call<SyncStatus>("get_status"),
  connect: (args: ConnectArgs) => call<SyncOutcome>("connect", { args }),
  signOut: () => call<Snapshot>("sign_out"),
  syncNow: () => call<SyncOutcome>("sync_now"),
  createTask: (listId: string, task: NewTask) => call<TaskResult>("create_task", { listId, task }),
  updateTask: (id: string, patch: TaskPatch) => call<TaskResult>("update_task", { id, patch }),
  moveTask: (id: string, listId: string) => call<Snapshot>("move_task", { id, listId }),
  deleteTasks: (ids: string[]) => call<DeleteResult>("delete_tasks", { ids }),
  undoDelete: (token: number) => call<Snapshot>("undo_delete", { token }),
  createList: (name: string, color: string | null) => call<Snapshot>("create_list", { name, color }),
  updateList: (id: string, name: string | null, color: string | null) =>
    call<Snapshot>("update_list", { id, name, color }),
  deleteList: (id: string) => call<Snapshot>("delete_list", { id }),
};

export async function showWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  await w.show();
  await w.setFocus();
}

export async function appVersion(): Promise<string> {
  if (!isTauri) return "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
