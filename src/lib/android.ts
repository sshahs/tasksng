/**
 * The Android app: reminder buttons and the Back gesture. Reminders
 * themselves are scheduled by the backend (src-tauri/src/mobile.rs).
 */
import { useEffect } from "react";

import { api, isTauri } from "./api";
import { androidBridge, isAndroid } from "./platform";
import { useStore } from "./store";

export const isAndroidApp = isTauri && isAndroid;

/** What the notification plugin reports when a reminder is tapped. */
interface NotificationAction {
  actionId?: string;
  notification?: { extra?: Record<string, unknown> } | null;
}

function handleAction(a: NotificationAction) {
  const uid = a.notification?.extra?.uid;
  if (typeof uid !== "string" || !uid) return;
  if (a.actionId === "done" || a.actionId === "snooze") void api.reminderAction(uid, a.actionId);
  else void api.reminderAction(uid, "open");
}

/** A reminder button that started the app; call once the tasks are loaded. */
export function takeLaunchAction() {
  if (!isAndroidApp) return;
  const json = androidBridge()?.takeLaunchAction();
  if (!json) return;
  try {
    handleAction(JSON.parse(json) as NotificationAction);
  } catch {
    // Not from a reminder.
  }
}

/** Back closes whatever is on top, one thing at a time. */
function handleBack() {
  const s = useStore.getState();
  if (document.querySelector("[role=dialog],[role=alertdialog],[role=menu],[data-radix-popper-content-wrapper]")) {
    // Dialogs, menus and pickers close on Escape.
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  } else if (s.drawerOpen) {
    s.set({ drawerOpen: false });
  } else if (s.selectedId) {
    s.select(null);
  } else if (s.search) {
    s.set({ search: "" });
  } else {
    androidBridge()?.moveToBack();
  }
}

export function useAndroid() {
  useEffect(() => {
    if (!isAndroidApp) return;
    const listeners = [
      import("@tauri-apps/plugin-notification").then(({ onAction }) =>
        onAction((a) => handleAction(a as unknown as NotificationAction)),
      ),
      import("@tauri-apps/api/app").then(({ onBackButtonPress }) => onBackButtonPress(handleBack)),
    ];
    return () => listeners.forEach((l) => void l.then((listener) => listener.unregister()).catch(() => undefined));
  }, []);
}
