import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";

import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Boxes that are on screen already: their tick draws itself in when checked. */
const shown = new WeakSet<Element>();

function seen(el: HTMLButtonElement | null) {
  // After this commit: a box that appears checked shows its tick at once.
  if (el) queueMicrotask(() => shown.add(el));
}

function draw(svg: SVGSVGElement | null) {
  const box = svg?.closest("[data-slot=checkbox]");
  if (!svg || !box || !shown.has(box) || prefersReducedMotion()) return;
  svg.querySelector("path")?.animate(
    [
      { strokeDasharray: 24, strokeDashoffset: 24 },
      { strokeDasharray: 24, strokeDashoffset: 0 },
    ],
    { duration: 300, delay: 40, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" },
  );
}

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      ref={seen}
      data-slot="checkbox"
      className={cn(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-[background-color,border-color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon ref={draw} className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
