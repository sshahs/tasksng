import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  ConnectArgs,
  DeleteResult,
  NewTask,
  SettingsPatch,
  SettingsView,
  Snapshot,
  SyncOutcome,
  SyncStatus,
  TaskPatch,
  TaskResult,
  TaskUpdate,
} from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, handler: (payload: T) => void) => Promise<UnlistenFn>;

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/**
 * The self-hosted web version (tasksng-server). `npm run dev` uses the demo
 * backend unless VITE_BACKEND=server; VITE_BACKEND=demo builds with it.
 */
export const isWeb =
  !isTauri &&
  import.meta.env.VITE_BACKEND !== "demo" &&
  (!import.meta.env.DEV || import.meta.env.VITE_BACKEND === "server");

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
      if (isWeb) {
        const { createHttpBackend } = await import("./http-backend");
        return createHttpBackend();
      }
      // Browser preview (npm run dev): an in-memory backend with demo data.
      const mock = await import("./mock-backend");
      return mock.createMockBackend();
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
  updateTasks: (updates: TaskUpdate[]) => call<Snapshot>("update_tasks", { updates }),
  moveTask: (id: string, listId: string) => call<Snapshot>("move_task", { id, listId }),
  deleteTasks: (ids: string[]) => call<DeleteResult>("delete_tasks", { ids }),
  undoDelete: (token: number) => call<Snapshot>("undo_delete", { token }),
  createList: (name: string, color: string | null) => call<Snapshot>("create_list", { name, color }),
  updateList: (id: string, name: string | null, color: string | null) =>
    call<Snapshot>("update_list", { id, name, color }),
  deleteList: (id: string) => call<Snapshot>("delete_list", { id }),
  prepareForUpdate: () => call<void>("prepare_for_update"),
  updatesSupported: () => call<boolean>("updates_supported"),
  getSettings: () => call<SettingsView>("get_settings"),
  updateSettings: (patch: SettingsPatch) => call<SettingsView>("update_settings", { patch }),
  suspendShortcut: (suspend: boolean) => call<void>("suspend_shortcut", { suspend }),
  openLink: (url: string) => call<void>("open_link", { url }),
  reminderAction: (uid: string, action: "done" | "snooze" | "open", minutes?: number) =>
    call<void>("reminder_action", { uid, action, minutes }),
  testNotification: () => call<void>("test_notification"),
  hideQuickAdd: () => call<void>("hide_quick_add"),
  quitApp: () => call<void>("quit_app"),
};

/**
 * Tells the backend the page has painted, which then shows the window.
 * Hidden windows don't get animation frames, so a timer backs that up.
 */
export function windowReady() {
  if (!isTauri) return;
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    void call<void>("window_ready").catch(() => undefined);
  };
  requestAnimationFrame(send);
  window.setTimeout(send, 60);
}

/** Which window this page runs in ("main" or "quick-add"). */
export function windowLabel(): string {
  if (isTauri) {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label ?? "main";
  }
  if (isWeb) return "main";
  return new URLSearchParams(location.search).get("window") ?? "main";
}

export async function appVersion(): Promise<string> {
  if (isWeb) {
    const { serverInfo } = await import("./http-backend");
    return (await serverInfo()).version;
  }
  if (!isTauri) return "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
