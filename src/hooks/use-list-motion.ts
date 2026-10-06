import { useLayoutEffect, useMemo, useReducer, useRef } from "react";

import type { Task } from "@/lib/types";

/** How long a finished task stays in place (tick, strike-through) before it slides away. */
export const LINGER_MS = 650;

/**
 * Tasks that were just completed while completed tasks are hidden. They stay
 * in the list for a moment so the tick and the strike-through can be seen.
 * Worked out while rendering, so the row never disappears for a frame.
 */
export function useJustCompleted(tasks: Record<string, Task>): ReadonlySet<string> {
  const committed = useRef(tasks);
  const until = useRef(new Map<string, number>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const fresh: string[] = [];
  const before = committed.current;
  if (before !== tasks) {
    for (const id in tasks) {
      const was = before[id];
      if (was && !was.completed && tasks[id].completed) fresh.push(id);
    }
  }
  const now = Date.now();
  const ids = [...fresh];
  for (const [id, end] of until.current) if (end > now) ids.push(id);
  ids.sort();
  const key = ids.join("\n");

  useLayoutEffect(() => {
    committed.current = tasks;
    if (!fresh.length) return;
    const end = Date.now() + LINGER_MS;
    for (const id of fresh) until.current.set(id, end);
    // Not cleared on re-render: other changes must not keep a task around.
    window.setTimeout(() => {
      const t = Date.now();
      for (const [id, e] of until.current) if (e <= t) until.current.delete(id);
      rerender();
    }, LINGER_MS + 16);
  });

  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/**
 * Whether many rows came or went at once (a search, a filter, showing
 * completed tasks). Those changes show up at once instead of one row at a
 * time: animating dozens of heights together looks busy and costs frames.
 */
export function useBigChange(keys: string[], limit = 20): boolean {
  const committed = useRef<Set<string> | null>(null);
  const prev = committed.current;
  let changed = 0;
  if (prev) {
    const next = new Set(keys);
    for (const k of next) if (!prev.has(k)) changed++;
    for (const k of prev) if (!next.has(k)) changed++;
  }
  useLayoutEffect(() => {
    committed.current = new Set(keys);
  });
  return changed > limit;
}
