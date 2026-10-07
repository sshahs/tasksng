import { useEffect, useRef } from "react";

export interface Hotkey {
  /** e.g. "mod+k", "shift+?", "delete", "j" — `mod` is Ctrl on Windows. */
  keys: string;
  handler: (e: KeyboardEvent) => void;
  /** Also fire while typing in an input/textarea. */
  inInputs?: boolean;
}

function matches(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop()!;
  const want = { ctrl: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === "mod" || p === "ctrl") want.ctrl = true;
    else if (p === "shift") want.shift = true;
    else if (p === "alt") want.alt = true;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl !== want.ctrl || e.altKey !== want.alt) return false;
  // Shifted symbols ("?") already encode shift in e.key; letters don't ("z" vs "shift+z").
  if (want.shift !== e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) return false;
  const k = e.key.toLowerCase();
  return k === key || (key === "space" && k === " ") || (key === "esc" && k === "escape");
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function useHotkeys(hotkeys: Hotkey[]) {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // Let menus and dialogs handle their own keys.
      const inOverlay = (e.target as HTMLElement | null)?.closest?.(
        "[role=dialog],[role=alertdialog],[role=menu],[data-radix-popper-content-wrapper]",
      );
      for (const h of ref.current) {
        if (!matches(e, h.keys)) continue;
        if (!h.inInputs && (isTyping(e.target) || inOverlay)) continue;
        e.preventDefault();
        h.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
