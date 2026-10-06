import { useLayoutEffect, useReducer, useRef } from "react";

/** How long a removed row takes to fade away (matches `.row-leave`). */
export const LEAVE_MS = 220;

export interface Present<T> {
  key: string;
  item: T;
  /** Added in this render: fades into place. */
  entering: boolean;
  /** Removed: still shown while it fades away. */
  leaving: boolean;
}

export interface Committed<T> {
  list: Present<T>[];
  /** When each leaving row started to leave. */
  since: Map<string, number>;
}

/**
 * The rows to show: the new items, plus the ones that went away since the
 * last render (or are still fading) right after the row they followed.
 */
export function presentList<T extends { key: string }>(
  prev: Committed<T> | null,
  items: T[],
  instant: boolean,
  now: number,
): Present<T>[] {
  if (!prev || instant) return items.map((item) => ({ key: item.key, item, entering: false, leaving: false }));
  const keys = new Set(items.map((i) => i.key));
  const before = new Set(prev.list.filter((p) => !p.leaving).map((p) => p.key));
  const after = new Map<string | null, Present<T>[]>();
  let anchor: string | null = null;
  for (const p of prev.list) {
    if (keys.has(p.key)) {
      anchor = p.key;
      continue;
    }
    const started = prev.since.get(p.key) ?? now;
    if (now - started >= LEAVE_MS) continue;
    const group = after.get(anchor) ?? [];
    group.push({ ...p, entering: false, leaving: true });
    after.set(anchor, group);
  }
  const list = [...(after.get(null) ?? [])];
  for (const item of items) {
    list.push({ key: item.key, item, entering: !before.has(item.key), leaving: false });
    const gone = after.get(item.key);
    if (gone) list.push(...gone);
  }
  return list;
}

/**
 * Keeps removed rows in the list for a moment so they can fade away where
 * they were, and marks new ones so they can fade in. Plain data: the rows
 * animate with CSS, so long lists stay cheap.
 *
 * `instant` (a big change such as a search) skips both.
 */
export function usePresence<T extends { key: string }>(items: T[], instant: boolean): Present<T>[] {
  const committed = useRef<Committed<T> | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const prev = committed.current;
  const list = presentList(prev, items, instant, Date.now());

  useLayoutEffect(() => {
    const since = new Map<string, number>();
    const now = Date.now();
    let leaving = false;
    for (const p of list) {
      if (!p.leaving) continue;
      leaving = true;
      since.set(p.key, prev?.since.get(p.key) ?? now);
    }
    committed.current = { list, since };
    if (leaving) {
      // Drop the rows that finished fading away.
      const timer = window.setTimeout(rerender, LEAVE_MS + 20);
      return () => window.clearTimeout(timer);
    }
  });

  return list;
}
