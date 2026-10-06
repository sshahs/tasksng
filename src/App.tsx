import { useEffect, useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { AnimatePresence, domMax, LazyMotion, m, MotionConfig } from "motion/react";

import { CommandPalette } from "@/components/command-palette";
import { ConflictBanner, ConflictDialog } from "@/components/conflict-dialog";
import { ListDialog } from "@/components/list-dialog";
import { SearchDialog, TagDialog } from "@/components/search-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { SetupScreen } from "@/components/setup-screen";
import { Sidebar, SidebarDrawer } from "@/components/sidebar";
import { TaskDetail } from "@/components/task-detail";
import { TaskPane } from "@/components/task-pane";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTheme } from "@/hooks/use-theme";
import { takeLaunchAction, useAndroid } from "@/lib/android";
import { api, windowReady } from "@/lib/api";
import { spring } from "@/lib/motion";
import { getPref } from "@/lib/prefs";
import { SMART_VIEWS, useStore, type ViewId } from "@/lib/store";
import { useUpdates } from "@/lib/updater";

function useAutoSync() {
  const signedIn = useStore((s) => !!s.account);
  const offline = useStore((s) => s.status.state === "offline");
  const [minutes, setMinutes] = useState(() => getPref("sync-interval", 5));

  useEffect(() => {
    const onChange = () => setMinutes(getPref("sync-interval", 5));
    window.addEventListener("tasksng-sync-interval", onChange);
    return () => window.removeEventListener("tasksng-sync-interval", onChange);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const sync = () => void useStore.getState().sync();
    const stale = () => {
      const last = useStore.getState().lastSync;
      return !last || Date.now() - new Date(last).getTime() > 60_000;
    };
    const timers: number[] = [];
    if (minutes > 0) timers.push(window.setInterval(sync, minutes * 60_000));
    // While offline, retry every minute so queued changes go out quickly.
    if (offline) timers.push(window.setInterval(sync, 60_000));
    const onFocus = () => {
      if (document.visibilityState === "visible" && stale()) sync();
    };
    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      timers.forEach((t) => window.clearInterval(t));
      window.removeEventListener("online", sync);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [signedIn, minutes, offline]);
}

/** Looks for updates shortly after start-up and then every six hours. */
function useAutoUpdate() {
  const autoCheck = useUpdates((s) => s.autoCheck);
  const supported = useUpdates((s) => s.supported);
  useEffect(() => {
    void useUpdates.getState().detectSupport();
  }, []);
  useEffect(() => {
    if (!autoCheck || !supported) return;
    const check = () => void useUpdates.getState().check();
    const first = window.setTimeout(check, 8_000);
    const every = window.setInterval(check, 6 * 60 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [autoCheck, supported]);
}

export default function App() {
  useTheme();
  const ready = useStore((s) => s.ready);
  const account = useStore((s) => s.account);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const mobile = useIsMobile();
  const authRequired = useStore((s) => s.status.state === "auth-required");
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    useStore
      .getState()
      .init()
      .then(() => {
        // Show the window only once real content has painted (no white flash).
        windowReady();
        takeLaunchAction();
        if (useStore.getState().account) void useStore.getState().sync();
      })
      .catch((e) => {
        setFatal(String(e instanceof Error ? e.message : e));
        windowReady();
      });
  }, []);

  useAutoSync();
  useAutoUpdate();
  useAndroid();

  // Keep the browser engine's own shortcuts (reload, print, find) out of the way.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!import.meta.env.DEV && !t.closest("input, textarea")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);

  const s = () => useStore.getState();
  const goTo = (i: number) => {
    const views: ViewId[] = [...SMART_VIEWS.map((v) => v.id), ...s().lists.map((l) => `list:${l.id}` as ViewId)];
    if (views[i]) s().setView(views[i]);
  };
  useHotkeys([
    { keys: "mod+k", inInputs: true, handler: () => s().set({ paletteOpen: !s().paletteOpen }) },
    { keys: "mod+p", inInputs: true, handler: () => s().set({ paletteOpen: true }) },
    { keys: "mod+n", inInputs: true, handler: () => useStore.setState((x) => ({ focusQuickAdd: x.focusQuickAdd + 1 })) },
    { keys: "n", handler: () => useStore.setState((x) => ({ focusQuickAdd: x.focusQuickAdd + 1 })) },
    { keys: "mod+f", inInputs: true, handler: () => useStore.setState((x) => ({ focusSearch: x.focusSearch + 1 })) },
    { keys: "/", handler: () => useStore.setState((x) => ({ focusSearch: x.focusSearch + 1 })) },
    { keys: "f5", inInputs: true, handler: () => void s().sync(true) },
    { keys: "mod+r", inInputs: true, handler: () => void s().sync(true) },
    { keys: "mod+z", handler: () => void s().undo() },
    { keys: "mod+h", inInputs: true, handler: () => s().set({ showCompleted: !s().showCompleted }) },
    { keys: "mod+b", inInputs: true, handler: () => s().set({ sidebarOpen: !s().sidebarOpen }) },
    { keys: "mod+,", inInputs: true, handler: () => s().set({ settingsOpen: true }) },
    { keys: "mod+q", inInputs: true, handler: () => void api.quitApp() },
    ...Array.from({ length: 9 }, (_, i) => ({ keys: `mod+${i + 1}`, inInputs: true, handler: () => goTo(i) })),
  ]);

  return (
    // Less motion when the system asks for it: no movement, fades only.
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user" transition={spring}>
        <TooltipProvider>
          {fatal ? (
            <div className="text-destructive flex h-full items-center justify-center p-8 text-sm">{fatal}</div>
          ) : !ready ? null : !account ? (
            <SetupScreen />
          ) : (
            <div className="relative flex h-full overflow-hidden">
              {mobile ? (
                <SidebarDrawer />
              ) : (
                // The sidebar slides in and out (Ctrl+B) and the rest of the
                // window glides along with it: transforms only, so the task
                // list is laid out once rather than on every frame.
                <AnimatePresence initial={false} mode="popLayout">
                  {sidebarOpen && (
                    <m.div
                      key="sidebar"
                      className="z-10 h-full shrink-0"
                      initial={{ x: -240 }}
                      animate={{ x: 0 }}
                      exit={{ x: -240 }}
                    >
                      <Sidebar />
                    </m.div>
                  )}
                </AnimatePresence>
              )}
              <m.main layout="position" className="relative flex min-w-0 flex-1 flex-col">
                {authRequired && (
                  <div className="bg-destructive/10 text-destructive flex items-center gap-3 border-b px-4 py-2 text-sm">
                    <KeyRoundIcon className="size-4 shrink-0" />
                    <span className="flex-1">Your Baikal server rejected the saved password. Changes are kept until you sign in again.</span>
                    <Button size="sm" variant="outline" onClick={() => s().set({ settingsOpen: true })}>
                      Sign in
                    </Button>
                  </div>
                )}
                <ConflictBanner />
                <div className="relative flex min-h-0 flex-1">
                  <TaskPane />
                  <TaskDetail />
                </div>
              </m.main>
            </div>
          )}
          <CommandPalette />
          <ConflictDialog />
          <ListDialog />
          <SearchDialog />
          <TagDialog />
          <SettingsDialog />
          <Toaster position="bottom-center" closeButton />
        </TooltipProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
