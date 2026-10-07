/**
 * The Android app: reminder buttons, the Back gesture and the home screen
 * widget. Reminders themselves are scheduled by the backend
 * (src-tauri/src/mobile.rs), the widget is drawn by TodayWidget.kt.
 */
import { useEffect } from "react";
import { addDays, endOfDay } from "date-fns";

import { api, isTauri } from "./api";
import { androidBridge, isAndroid } from "./platform";
import { parseDue } from "./dates";
import { useStore } from "./store";
import type { Task, TaskList } from "./types";

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

/** A tap on the home screen widget. */
interface WidgetAction {
  widget: "open" | "add" | "today";
  taskId?: string;
}

function handleWidget(a: WidgetAction) {
  const s = useStore.getState();
  if (a.widget === "open" && a.taskId && s.tasks[a.taskId]) {
    s.openTask(a.taskId);
    return;
  }
  if (s.view !== "today") s.setView("today");
  if (a.widget === "add") {
    // After the view has rendered its add box.
    requestAnimationFrame(() => useStore.setState((x) => ({ focusQuickAdd: x.focusQuickAdd + 1 })));
  }
}

/** A reminder button or the widget started (or reopened) the app; call once the tasks are loaded. */
export function takeLaunchAction() {
  if (!isAndroidApp) return;
  const json = androidBridge()?.takeLaunchAction();
  if (!json) return;
  try {
    const action = JSON.parse(json) as NotificationAction & Partial<WidgetAction>;
    if (action.widget) handleWidget(action as WidgetAction);
    else handleAction(action);
  } catch {
    // Neither.
  }
}

/** What the widget needs of a task. */
interface WidgetItem {
  id: string;
  title: string;
  due: string | null;
  start: string | null;
  planned: string | null;
  snoozedUntil: string | null;
  color: string | null;
  priority: number;
}

/**
 * The open tasks of the coming week (and overdue ones). The widget picks
 * today's from them when it draws, so it is right after midnight too.
 */
export function widgetItems(tasks: Task[], lists: TaskList[], now = new Date()): WidgetItem[] {
  const until = endOfDay(addDays(now, 7)).getTime();
  const soon = (v: string | null) => {
    const d = parseDue(v);
    return !!d && d.date.getTime() <= until;
  };
  const color = new Map(lists.map((l) => [l.id, l.color]));
  return tasks
    .filter((t) => !t.completed && (soon(t.due) || soon(t.start) || soon(t.planned)))
    .slice(0, 300)
    .map((t) => ({
      id: t.id,
      title: t.summary,
      due: t.due,
      start: t.start,
      planned: t.planned,
      snoozedUntil: t.snoozedUntil,
      color: color.get(t.listId) ?? null,
      priority: t.priority,
    }));
}

/** Keeps the home screen widget up to date while the app runs. */
function feedWidget(): () => void {
  let timer: number | undefined;
  let sent = "";
  const send = () => {
    const s = useStore.getState();
    if (!s.ready) return;
    const json = JSON.stringify(s.account ? widgetItems(Object.values(s.tasks), s.lists) : []);
    if (json === sent) return;
    sent = json;
    androidBridge()?.updateWidget?.(json);
  };
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.tasks === prev.tasks && s.lists === prev.lists && s.account === prev.account && s.ready === prev.ready) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(send, 800);
  });
  // Leaving the app: make sure the widget has the latest.
  const onHide = () => document.visibilityState === "hidden" && send();
  document.addEventListener("visibilitychange", onHide);
  send();
  return () => {
    unsubscribe();
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onHide);
  };
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
    const stopFeed = feedWidget();
    // The widget reopened the running app.
    const onLaunch = () => takeLaunchAction();
    window.addEventListener("tasksng-launch", onLaunch);
    const listeners = [
      import("@tauri-apps/plugin-notification").then(({ onAction }) =>
        onAction((a) => handleAction(a as unknown as NotificationAction)),
      ),
      import("@tauri-apps/api/app").then(({ onBackButtonPress }) => onBackButtonPress(handleBack)),
    ];
    return () => {
      stopFeed();
      window.removeEventListener("tasksng-launch", onLaunch);
      listeners.forEach((l) => void l.then((listener) => listener.unregister()).catch(() => undefined));
    };
  }, []);
}
