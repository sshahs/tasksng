import { Component, type ReactNode, type RefObject } from "react";

import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Fades a new row in (Web Animations: unaffected by later re-renders). */
function fadeIn(el: HTMLElement | null) {
  if (!el || prefersReducedMotion()) return;
  el.animate([{ opacity: 0, transform: "translateY(-4px) scale(0.98)" }, { opacity: 1, transform: "none" }], {
    duration: 280,
    easing: EASE_OUT,
  });
}

/**
 * Props for one row of an animated list (a plain element, no component:
 * long lists render as fast as without animations). A new row fades in
 * where it belongs while the rows below glide down to make room; a leaving
 * row is taken out of the flow and fades where it was while the rows below
 * glide up (FlipList). Only transforms and opacity change from frame to
 * frame: the list is laid out once per change, however long it is.
 */
export function listItemProps(key: string, entering: boolean, leaving: boolean, className?: string) {
  return {
    ref: entering ? fadeIn : undefined,
    "data-flip": key,
    "data-leaving": leaving || undefined,
    "aria-hidden": leaving || undefined,
    className: cn(leaving && "row-leave", className),
  };
}

type Positions = Map<string, number>;

/** Where a row is on screen right now: its place plus any glide still under way. */
function visualTop(el: HTMLElement): number {
  const moving = el.getAnimations().some((a) => a.id === "flip");
  return el.offsetTop + (moving ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 : 0);
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > [data-flip]"));
}

/**
 * Glides rows to their new places when the order changes (sorting, drag and
 * drop, a task moving to "Completed"). Measures every row just before React
 * changes the page and again right after, then animates the difference with
 * transforms only. Rows far off screen just move.
 */
export class FlipList extends Component<{
  container: RefObject<HTMLElement | null>;
  /** The keys in order: rows only move when this changes. */
  order: string;
  disabled: boolean;
  children: ReactNode;
}> {
  getSnapshotBeforeUpdate(prev: { order: string }): Positions | null {
    const el = this.props.container.current;
    if (!el || prev.order === this.props.order || this.props.disabled || prefersReducedMotion()) return null;
    const before: Positions = new Map();
    for (const row of rows(el)) before.set(row.dataset.flip!, visualTop(row));
    return before;
  }

  componentDidUpdate(_: unknown, __: unknown, before: Positions | null) {
    const el = this.props.container.current;
    if (!el) return;
    // Leaving rows are out of the flow but stay where they were (their
    // static position); they keep the width of the list.
    let width: number | null = null;
    for (const row of rows(el)) {
      if (row.dataset.leaving && !row.style.width) {
        if (width === null) {
          const style = getComputedStyle(el);
          width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        }
        row.style.width = `${width}px`;
      } else if (!row.dataset.leaving && row.style.width) {
        row.style.width = "";
      }
    }
    if (!before) return;
    const top = el.scrollTop;
    const height = el.clientHeight;
    const near = (y: number) => y > top - height && y < top + 2 * height;
    for (const row of rows(el)) {
      if (row.dataset.leaving) continue;
      const was = before.get(row.dataset.flip!);
      if (was === undefined) continue;
      const now = row.offsetTop;
      const dy = was - now;
      if (Math.abs(dy) < 1 || !(near(was) || near(now))) continue;
      for (const a of row.getAnimations()) if (a.id === "flip") a.cancel();
      const glide = row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 340,
        easing: EASE_OUT,
      });
      glide.id = "flip";
      // Rows that cross each other: the one going furthest slides over the
      // others, on its own background, instead of the text mixing.
      if (!row.classList.contains("sticky")) {
        row.style.zIndex = String(1 + Math.round(Math.abs(dy) / 8));
        row.classList.add("flip-moving");
        glide.onfinish = () => {
          row.style.zIndex = "";
          row.classList.remove("flip-moving");
        };
      }
    }
  }

  render() {
    return this.props.children;
  }
}
