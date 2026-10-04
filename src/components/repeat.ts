import { describeRule } from "@/lib/rrule";

export const REPEAT_OPTIONS = [
  { value: "none", label: "Does not repeat", rrule: null },
  { value: "daily", label: "Every day", rrule: "FREQ=DAILY" },
  { value: "weekdays", label: "Every weekday", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { value: "weekly", label: "Every week", rrule: "FREQ=WEEKLY" },
  { value: "biweekly", label: "Every 2 weeks", rrule: "FREQ=WEEKLY;INTERVAL=2" },
  { value: "monthly", label: "Every month", rrule: "FREQ=MONTHLY" },
  { value: "yearly", label: "Every year", rrule: "FREQ=YEARLY" },
] as const;

export function repeatValue(rrule: string | null): string {
  if (!rrule) return "none";
  const norm = rrule.toUpperCase().replace(/^RRULE:/, "");
  return REPEAT_OPTIONS.find((o) => o.rrule === norm)?.value ?? "custom";
}

export function repeatLabel(rrule: string | null): string | null {
  if (!rrule) return null;
  const v = repeatValue(rrule);
  return v === "custom" ? describeRule(rrule) : (REPEAT_OPTIONS.find((o) => o.value === v)?.label ?? null);
}
