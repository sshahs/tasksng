import { useEffect, useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { api, isTauri } from "@/lib/api";
import { cn } from "@/lib/utils";

export const DEFAULT_SHORTCUT = "Super+Alt+N";

/** "Super+Alt+N" → ["Win", "Alt", "N"] */
export function shortcutKeys(s: string): string[] {
  return s.split("+").map((k) => (k === "Super" ? "Win" : k === "Control" ? "Ctrl" : k));
}

/** The accelerator for a key press, or null while only modifiers are held. */
export function acceleratorFor(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  // Plain letters would fire while typing anywhere; function keys may stand alone.
  if (!mods.length && !key.startsWith("F")) return null;
  if (mods.length === 1 && mods[0] === "Shift" && !key.startsWith("F")) return null;
  return [...mods, key].join("+");
}

export function ShortcutRecorder({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (shortcut: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!recording) return;
    // Otherwise pressing the current shortcut would open quick add.
    if (isTauri) void api.suspendShortcut(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const acc = acceleratorFor(e);
      if (acc) {
        setRecording(false);
        onChangeRef.current(acc);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (isTauri) void api.suspendShortcut(false);
    };
  }, [recording]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        className={cn(
          "border-input flex h-8 min-w-36 items-center justify-center gap-1 rounded-md border px-2 text-sm transition-colors disabled:opacity-50",
          recording ? "border-ring ring-ring/40 ring-[3px]" : "hover:bg-accent",
        )}
        aria-label="Change shortcut"
      >
        {recording ? (
          <span className="text-muted-foreground">Press keys…</span>
        ) : value ? (
          shortcutKeys(value).map((k) => <Kbd key={k}>{k}</Kbd>)
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </button>
      {value !== DEFAULT_SHORTCUT && !disabled && (
        <Button variant="ghost" size="icon-sm" onClick={() => onChange(DEFAULT_SHORTCUT)} aria-label="Reset to Win+Alt+N" title="Reset to Win+Alt+N">
          <RotateCcwIcon />
        </Button>
      )}
    </div>
  );
}
