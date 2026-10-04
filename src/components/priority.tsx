import { FlagIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type PriorityLevel = "none" | "high" | "medium" | "low";

export const PRIORITIES: { level: PriorityLevel; value: number; label: string }[] = [
  { level: "high", value: 1, label: "High" },
  { level: "medium", value: 5, label: "Medium" },
  { level: "low", value: 9, label: "Low" },
  { level: "none", value: 0, label: "None" },
];

export function priorityLevel(p: number): PriorityLevel {
  if (p >= 1 && p <= 4) return "high";
  if (p === 5) return "medium";
  if (p >= 6 && p <= 9) return "low";
  return "none";
}

export const priorityText: Record<PriorityLevel, string> = {
  high: "text-priority-high",
  medium: "text-priority-medium",
  low: "text-priority-low",
  none: "text-muted-foreground",
};

export const priorityBorder: Record<PriorityLevel, string> = {
  high: "border-priority-high data-[state=checked]:bg-priority-high data-[state=checked]:border-priority-high",
  medium: "border-priority-medium data-[state=checked]:bg-priority-medium data-[state=checked]:border-priority-medium",
  low: "border-priority-low data-[state=checked]:bg-priority-low data-[state=checked]:border-priority-low",
  none: "border-muted-foreground/50",
};

export function PriorityFlag({ priority, className }: { priority: number; className?: string }) {
  const level = priorityLevel(priority);
  if (level === "none") return null;
  return <FlagIcon className={cn("size-3.5 fill-current", priorityText[level], className)} aria-label={`${level} priority`} />;
}
