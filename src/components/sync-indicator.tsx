import { useEffect, useState } from "react";
import { AlertTriangleIcon, CheckIcon, CloudOffIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/dates";
import { useStore } from "@/lib/store";

export function SyncIndicator() {
  const status = useStore((s) => s.status);
  const lastSync = useStore((s) => s.lastSync);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const pending = status.pending;
  let icon = <CheckIcon className="text-emerald-500" />;
  let text = `Synced ${relativeTime(lastSync)}`;
  if (status.state === "syncing") {
    icon = <RefreshCwIcon className="animate-spin" />;
    text = "Syncing…";
  } else if (status.state === "offline") {
    icon = <CloudOffIcon className="text-amber-500" />;
    text = pending ? `Offline · ${pending} change${pending === 1 ? "" : "s"} waiting` : "Offline";
  } else if (status.state === "auth-required") {
    icon = <KeyRoundIcon className="text-destructive" />;
    text = "Sign in required";
  } else if (status.state === "error") {
    icon = <AlertTriangleIcon className="text-destructive" />;
    text = "Sync problem";
  } else if (pending) {
    icon = <RefreshCwIcon />;
    text = `${pending} change${pending === 1 ? "" : "s"} to sync`;
  }

  const button = (
    <button
      onClick={() => {
        if (status.state === "auth-required") useStore.getState().set({ settingsOpen: true });
        else void useStore.getState().sync(true);
      }}
      className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {/* The icon and text swap in when the state changes. */}
      <span key={status.state} className="animate-in fade-in-0 zoom-in-75 flex duration-300">
        {icon}
      </span>
      <span key={text} className="animate-in fade-in-0 truncate duration-300">
        {text}
      </span>
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        {status.message ?? (status.state === "auth-required" ? "Open settings to sign in" : "Click to sync now (F5)")}
      </TooltipContent>
    </Tooltip>
  );
}
