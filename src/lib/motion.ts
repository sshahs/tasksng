import type { Transition } from "motion/react";

/**
 * Shared timing so everything moves alike. Springs without bounce for things
 * that move (they pick up the speed of an interrupted animation, so quick
 * clicks never stutter), a short ease-out for fades.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export const spring: Transition = { type: "spring", bounce: 0, visualDuration: 0.32 };
export const snappy: Transition = { type: "spring", bounce: 0, visualDuration: 0.22 };
export const fade: Transition = { duration: 0.18, ease: EASE_OUT };

/** Whether the user asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
