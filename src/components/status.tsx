import { BanIcon, CheckCircle2Icon, CircleDashedIcon, CircleIcon } from "lucide-react";

import type { TaskStatus } from "@/lib/types";

export const STATUSES: { value: TaskStatus; label: string; icon: React.ReactNode }[] = [
  { value: "needs-action", label: "To do", icon: <CircleIcon /> },
  { value: "in-process", label: "In progress", icon: <CircleDashedIcon /> },
  { value: "completed", label: "Done", icon: <CheckCircle2Icon /> },
  { value: "cancelled", label: "Cancelled", icon: <BanIcon /> },
];
