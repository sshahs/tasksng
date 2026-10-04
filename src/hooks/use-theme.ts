import { useEffect, useSyncExternalStore } from "react";

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
  document.documentElement.classList.toggle("dark", resolve(current) === "dark");
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
  apply();
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
