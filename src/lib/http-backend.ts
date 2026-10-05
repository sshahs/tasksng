/**
 * Backend for the self-hosted web version: the same commands as the desktop
 * app, sent to tasksng-server as `POST api/<command>`, with live updates over
 * Server-Sent Events (`api/events`).
 */
import type { UnlistenFn } from "@tauri-apps/api/event";

type Handler = (payload: unknown) => void;

export interface ServerInfo {
  version: string;
  /** Set when everyone signs in to this one CalDAV server. */
  caldavUrl: string | null;
}

/** Desktop-only commands, answered here. */
const LOCAL: Record<string, (args: Record<string, unknown>) => unknown> = {
  window_ready: () => null,
  hide_quick_add: () => null,
  suspend_shortcut: () => null,
  quit_app: () => null,
  prepare_for_update: () => null,
  updates_supported: () => false,
  open_link: ({ url }) => {
    window.open(String(url), "_blank", "noopener,noreferrer");
    return null;
  },
  test_notification: async () => {
    if (!("Notification" in window)) throw new Error("This browser can't show notifications");
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      throw new Error("Notifications are blocked for this site. Allow them in your browser's site settings.");
    }
    new Notification("This is how reminders look", { body: "Reminders appear like this while TasksNG is open in a tab." });
    return null;
  },
};

export function createHttpBackend() {
  const handlers = new Map<string, Set<Handler>>();
  let source: EventSource | null = null;

  const attach = (es: EventSource, name: string) =>
    es.addEventListener(name, (e) => {
      let payload: unknown;
      try {
        payload = JSON.parse((e as MessageEvent<string>).data);
      } catch {
        return;
      }
      handlers.get(name)?.forEach((h) => h(payload));
    });

  /** (Re)opens the event stream, e.g. after signing in. */
  const connectEvents = () => {
    source?.close();
    source = new EventSource("api/events");
    for (const name of handlers.keys()) attach(source, name);
    // Not signed in: the server refuses the stream and the browser stops
    // retrying, which is fine; signing in opens a new one.
  };

  async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const local = LOCAL[cmd];
    if (local) return (await local(args ?? {})) as T;
    const res = await fetch(`api/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TasksNG": "1" },
      credentials: "same-origin",
      body: JSON.stringify(args ?? {}),
    }).catch(() => {
      throw new Error("Can't reach the TasksNG server");
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const message = (body as { error?: string } | null)?.error;
      throw new Error(message ?? `The TasksNG server returned ${res.status}`);
    }
    if (cmd === "connect" || cmd === "sign_out") connectEvents();
    return body as T;
  }

  async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (!source) connectEvents();
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
      if (source) attach(source, event);
    }
    set.add(handler as Handler);
    return () => {
      set.delete(handler as Handler);
    };
  }

  return { invoke, listen };
}

let info: Promise<ServerInfo> | null = null;

/** Version and sign-in settings of the server (cached). */
export function serverInfo(): Promise<ServerInfo> {
  info ??= fetch("api/server_info", { method: "POST", headers: { "X-TasksNG": "1" } })
    .then((r) => r.json() as Promise<ServerInfo>)
    .catch(() => ({ version: "", caldavUrl: null }));
  return info;
}
