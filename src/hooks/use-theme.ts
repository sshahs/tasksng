import { useEffect, useSyncExternalStore } from "react";

import { prefersReducedMotion } from "@/lib/motion";
import { androidBridge } from "@/lib/platform";

export type Theme = "system" | "light" | "dark";

const KEY = "tasksng-theme";
const listeners = new Set<() => void>();
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

let current: Theme = readTheme();

function resolve(theme: Theme): "light" | "dark" {
  if (theme === "system") return media?.matches ? "dark" : "light";
  return theme;
}

function apply() {
  const dark = resolve(current) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  androidBridge()?.setDarkTheme(dark);
  listeners.forEach((l) => l());
}

media?.addEventListener("change", () => {
  if (current === "system") apply();
});

export function setTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // ignore
  }
  // Cross-fade the whole window into the new colours where the engine can.
  const dark = document.documentElement.classList.contains("dark");
  const changes = (resolve(theme) === "dark") !== dark;
  if (changes && document.startViewTransition && !prefersReducedMotion()) document.startViewTransition(apply);
  else apply();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current);
  const resolved = useSyncExternalStore(subscribe, () => resolve(current));
  useEffect(() => {
    apply();
  }, []);
  return { theme, resolved, setTheme };
}
