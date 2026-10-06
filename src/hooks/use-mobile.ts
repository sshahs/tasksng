import { useSyncExternalStore } from "react";

/** Phones (and very narrow windows) get the one-column layout. */
const narrow = typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)") : null;
/** Fingers rather than a mouse: no hover, drag and drop or keyboard hints. */
const coarse = typeof window !== "undefined" ? window.matchMedia("(pointer: coarse)") : null;

function subscribe(cb: () => void) {
  narrow?.addEventListener("change", cb);
  return () => narrow?.removeEventListener("change", cb);
}

export function isMobileLayout(): boolean {
  return !!narrow?.matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobileLayout, () => false);
}

export function isTouch(): boolean {
  return !!coarse?.matches;
}
