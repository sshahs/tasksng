import { relaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheck, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { create } from "zustand";

import { api, isTauri } from "./api";
import { getPref, setPref } from "./prefs";

/**
 * Auto-update: checks GitHub Releases for a newer signed build, downloads it
 * in the background and offers a restart once it is ready. The download is
 * verified against the public key baked into the app before it can be
 * installed.
 */

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

interface PendingUpdate {
  version: string;
  body?: string;
  download(onEvent?: (e: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  /** 0…1 while downloading, when the size is known. */
  progress: number | null;
  error: string | null;
  lastChecked: number | null;
  autoCheck: boolean;
  /** False for the portable exe (and the browser preview). */
  supported: boolean;
  detectSupport(): Promise<boolean>;
  check(manual?: boolean): Promise<void>;
  install(): Promise<void>;
  setAutoCheck(on: boolean): void;
}

/** The downloaded update lives outside React state (it holds a native resource). */
let pending: PendingUpdate | null = null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function findUpdate(): Promise<PendingUpdate | null> {
  if (isTauri) return tauriCheck();
  if (import.meta.env.DEV && location.search.includes("update")) return mockUpdate();
  return null;
}

export const useUpdates = create<UpdateState>()((set, get) => ({
  phase: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
  lastChecked: null,
  autoCheck: getPref("auto-update", true),
  supported: false,

  async detectSupport() {
    let supported = false;
    if (isTauri) supported = await api.updatesSupported().catch(() => false);
    else supported = import.meta.env.DEV && location.search.includes("update");
    set({ supported });
    return supported;
  },

  async check(manual = false) {
    const { phase, supported } = get();
    if (!supported) return;
    if (phase === "checking" || phase === "downloading" || phase === "installing") return;
    if (phase === "ready") {
      if (manual) notifyReady();
      return;
    }
    set({ phase: "checking", error: null });
    try {
      const update = await findUpdate();
      set({ lastChecked: Date.now() });
      if (!update) {
        set({ phase: "idle" });
        if (manual) toast.success("TasksNG is up to date");
        return;
      }
      set({ phase: "downloading", version: update.version, notes: update.body ?? null, progress: null });
      let total = 0;
      let received = 0;
      await update.download((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          received += e.data.chunkLength;
          if (total > 0) set({ progress: Math.min(1, received / total) });
        }
      });
      pending = update;
      set({ phase: "ready", progress: 1 });
      notifyReady();
    } catch (e) {
      // Background checks fail quietly (offline, GitHub hiccups); they retry later.
      set({ phase: "error", error: message(e) });
      if (manual) toast.error(`Couldn't update: ${message(e)}`);
    }
  },

  async install() {
    if (!pending || get().phase === "installing") return;
    set({ phase: "installing" });
    try {
      // Make sure local changes are on disk; on Windows the installer takes
      // over immediately and the app is closed without the usual exit hooks.
      if (isTauri) await api.prepareForUpdate();
      await pending.install();
      // Windows never gets here (the installer restarts the app); other
      // platforms need an explicit relaunch.
      if (isTauri) await relaunch();
    } catch (e) {
      set({ phase: "ready", error: message(e) });
      toast.error(`Couldn't install the update: ${message(e)}`);
    }
  },

  setAutoCheck(on) {
    setPref("auto-update", on);
    set({ autoCheck: on });
  },
}));

function notifyReady() {
  const { version } = useUpdates.getState();
  toast(`TasksNG ${version} is ready`, {
    id: "update-ready",
    description: "Restart the app to finish updating. Your tasks are kept.",
    duration: 20_000,
    action: { label: "Restart now", onClick: () => void useUpdates.getState().install() },
  });
}

/** Browser preview only (`npm run dev`, URL contains `?update`). */
function mockUpdate(): PendingUpdate {
  return {
    version: "0.2.0",
    body: "Demo update",
    async download(onEvent) {
      onEvent?.({ event: "Started", data: { contentLength: 1000 } });
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 150));
        onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      }
      onEvent?.({ event: "Finished" });
    },
    async install() {
      toast.info("The desktop app would now restart into the new version.");
      useUpdates.setState({ phase: "ready" });
    },
  };
}
