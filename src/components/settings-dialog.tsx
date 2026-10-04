import { useEffect, useState } from "react";
import { BellRingIcon, DownloadIcon, Loader2Icon, LogOutIcon, MonitorIcon, MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { api, appVersion, isTauri } from "@/lib/api";
import { relativeTime } from "@/lib/dates";
import { getPref, setPref } from "@/lib/prefs";
import { DEFAULT_REMINDERS } from "@/lib/reminders";
import { useStore } from "@/lib/store";
import { useUpdates } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { ConnectForm } from "./connect-form";
import { ShortcutRecorder } from "./shortcut-recorder";

export const SYNC_INTERVALS = [
  { value: "1", label: "Every minute" },
  { value: "5", label: "Every 5 minutes" },
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "0", label: "Only manually" },
];

export const SHORTCUTS: [string, string][] = [
  ["N", "New task"],
  ["Win Alt N", "Quick add anywhere"],
  ["Ctrl K", "Command palette / jump to task"],
  ["Ctrl F", "Search"],
  ["↑ ↓", "Move selection"],
  ["Space", "Complete / reopen"],
  ["I", "In progress"],
  ["Alt ↑ ↓", "Move up / down"],
  ["Alt → ←", "Indent / outdent"],
  ["Enter", "Edit title"],
  ["1 2 3 0", "Set priority"],
  ["T / M", "Due today / tomorrow"],
  ["Del", "Delete"],
  ["Ctrl Z", "Undo delete"],
  ["Ctrl H", "Show / hide completed"],
  ["Ctrl 1…9", "Switch list"],
  ["Ctrl B", "Toggle sidebar"],
  ["F5", "Sync now"],
];

const THEMES: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "System", icon: <MonitorIcon /> },
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const account = useStore((s) => s.account);
  const status = useStore((s) => s.status);
  const lastSync = useStore((s) => s.lastSync);
  const { theme, setTheme } = useTheme();
  const [interval, setIntervalPref] = useState(() => String(getPref("sync-interval", 5)));
  const [reauth, setReauth] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (open) {
      void appVersion().then(setVersion);
      setReauth(status.state === "auth-required");
    }
  }, [open, status.state]);

  const close = () => useStore.getState().set({ settingsOpen: false });

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription className="sr-only">Account, appearance and sync settings</DialogDescription>
          </DialogHeader>

          {account && (
            <section className="grid gap-3">
              <h3 className="text-sm font-medium">Account</h3>
              <div className="bg-muted/40 grid gap-1 rounded-md border p-3 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Server</span>
                  <span className="truncate">{account.serverUrl}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">User</span>
                  <span className="truncate">{account.username}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Last sync</span>
                  <span>{relativeTime(lastSync)}</span>
                </div>
                {status.message && <p className="text-destructive mt-1 text-xs">{status.message}</p>}
              </div>
              {reauth ? (
                <div className="rounded-md border p-4">
                  <ConnectForm
                    initial={account}
                    submitLabel="Sign in"
                    onConnected={() => {
                      setReauth(false);
                      close();
                    }}
                  />
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void useStore.getState().sync(true)}>
                    <RefreshCwIcon className={cn(status.state === "syncing" && "animate-spin")} /> Sync now
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setReauth(true)}>
                    Change password…
                  </Button>
                  <div className="flex-1" />
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmSignOut(true)}>
                    <LogOutIcon /> Sign out
                  </Button>
                </div>
              )}
            </section>
          )}

          <Separator />

          <section className="grid gap-3">
            <h3 className="text-sm font-medium">Appearance</h3>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTheme(t.value)}
                  className={cn(
                    "hover:bg-accent flex flex-col items-center gap-1.5 rounded-md border p-3 text-sm [&_svg]:size-5",
                    theme === t.value && "border-primary ring-primary/30 ring-2",
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <Separator />

          <section className="flex items-center justify-between gap-4">
            <div>
              <Label>Sync automatically</Label>
              <p className="text-muted-foreground mt-1 text-xs">Changes you make are always sent right away.</p>
            </div>
            <Select
              value={interval}
              onValueChange={(v) => {
                setIntervalPref(v);
                setPref("sync-interval", Number(v));
                window.dispatchEvent(new Event("tasksng-sync-interval"));
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYNC_INTERVALS.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <Separator />

          <BackgroundSection />

          <Separator />

          <UpdatesSection version={version} />

          <Separator />

          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Keyboard shortcuts</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
              {SHORTCUTS.map(([k, label]) => (
                <div key={k} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground truncate">{label}</span>
                  <Kbd className="shrink-0 whitespace-nowrap">{k}</Kbd>
                </div>
              ))}
            </div>
          </section>

        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out?</AlertDialogTitle>
            <AlertDialogDescription>
              Your tasks stay on the server. Changes that haven&apos;t been synced yet
              {status.pending ? ` (${status.pending})` : ""} will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => {
                close();
                void useStore.getState().signOut();
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SettingRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
    </div>
  );
}

/** Reminders, running in the notification area, start-up and quick add. */
function BackgroundSection() {
  const settings = useStore((s) => s.settings);
  if (!settings) return null;
  const save = (patch: Parameters<ReturnType<typeof useStore.getState>["saveSettings"]>[0]) => void useStore.getState().saveSettings(patch);
  const defaultValue = DEFAULT_REMINDERS.find((d) => d.offset === settings.defaultReminder)?.value ?? "off";

  return (
    <section className="grid gap-4">
      <h3 className="text-sm font-medium">Reminders &amp; background</h3>
      <SettingRow
        id="reminders"
        label="Show reminders"
        hint={settings.nativeNotifications ? "As Windows notifications with Snooze and Done buttons." : "Inside the app (Windows notifications need the desktop app on Windows)."}
        checked={settings.reminders}
        onChange={(reminders) => save({ reminders })}
      />
      <div className="flex items-center justify-between gap-4 pl-12">
        <Label className="text-muted-foreground font-normal" title="For tasks with a due time and no reminder of their own">
          Automatic reminder
        </Label>
        <Select
          value={defaultValue}
          disabled={!settings.reminders}
          onValueChange={(v) => save({ defaultReminder: DEFAULT_REMINDERS.find((d) => d.value === v)?.offset ?? null })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_REMINDERS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {settings.nativeNotifications && (
        <div className="pl-12">
          <Button
            variant="outline"
            size="sm"
            disabled={!settings.reminders}
            onClick={() =>
              void api.testNotification().catch((e) => toast.error(`Couldn't show a notification: ${e instanceof Error ? e.message : e}`))
            }
          >
            <BellRingIcon /> Send a test notification
          </Button>
        </div>
      )}
      <SettingRow
        id="close-to-tray"
        label="Keep running in the notification area when closed"
        hint="Reminders and quick add keep working. Quit from the TasksNG icon next to the clock."
        checked={settings.closeToTray}
        onChange={(closeToTray) => save({ closeToTray })}
      />
      <SettingRow
        id="autostart"
        label="Start TasksNG when you sign in to Windows"
        hint="Starts quietly in the notification area."
        checked={settings.launchAtLogin}
        disabled={!isTauri}
        onChange={(launchAtLogin) => save({ launchAtLogin })}
      />
      <div className="grid gap-2">
        <SettingRow
          id="quick-add-shortcut"
          label="Quick add from anywhere"
          hint="Opens a small box for a new task on top of whatever you're doing."
          checked={settings.quickAddShortcut !== null}
          onChange={(on) => save({ quickAddShortcut: on ? "Super+Alt+N" : null })}
        />
        {settings.quickAddShortcut !== null && (
          <div className="flex items-center gap-3 pl-12">
            <ShortcutRecorder value={settings.quickAddShortcut} onChange={(quickAddShortcut) => save({ quickAddShortcut })} />
          </div>
        )}
        {settings.shortcutError && <p className="text-destructive pl-12 text-xs">{settings.shortcutError}</p>}
      </div>
    </section>
  );
}

function UpdatesSection({ version }: { version: string }) {
  const { phase, version: next, progress, error, lastChecked, autoCheck, supported } = useUpdates();
  if (!supported) {
    return (
      <section className="grid gap-1">
        <h3 className="text-sm font-medium">Updates</h3>
        <p className="text-muted-foreground text-xs">
          You have version {version || "…"}. Automatic updates are available when TasksNG is installed with the setup
          program; the portable version is updated by downloading a new copy.
        </p>
      </section>
    );
  }
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  let status: string;
  switch (phase) {
    case "checking":
      status = "Checking for updates…";
      break;
    case "downloading":
      status = `Downloading version ${next}${progress != null ? ` · ${Math.round(progress * 100)}%` : "…"}`;
      break;
    case "ready":
      status = `Version ${next} is ready to install.`;
      break;
    case "installing":
      status = `Installing version ${next}…`;
      break;
    case "error":
      status = `Couldn't check for updates: ${error}`;
      break;
    default:
      status = lastChecked ? `Up to date · checked ${relativeTime(new Date(lastChecked).toISOString())}` : "Updates come from GitHub Releases.";
  }

  return (
    <section className="grid gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Updates</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            You have version {version || "…"}. <span className={phase === "error" ? "text-destructive" : ""}>{status}</span>
          </p>
        </div>
        {phase === "ready" || phase === "installing" ? (
          <Button size="sm" disabled={phase === "installing"} onClick={() => void useUpdates.getState().install()}>
            {phase === "installing" ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
            Restart &amp; update
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void useUpdates.getState().check(true)}>
            {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Check now
          </Button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Switch
          id="auto-update"
          checked={autoCheck}
          onCheckedChange={(on) => useUpdates.getState().setAutoCheck(on)}
        />
        <Label htmlFor="auto-update" className="font-normal">
          Check for updates automatically
        </Label>
      </div>
    </section>
  );
}
