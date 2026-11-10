/**
 * Pairing the web app with the TasksNG Android app: a code this browser
 * shows for a phone to scan (Settings), signing in from a phone (sign-in
 * page), and the page a phone opens when it scans a code with its camera.
 */
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { CheckIcon, Loader2Icon, RefreshCwIcon, SmartphoneIcon, XIcon } from "lucide-react";

import { HoverBorderGradient } from "@/components/aceternity/hover-border-gradient";
import { Spotlight } from "@/components/aceternity/spotlight-new";
import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import { api, on } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { LinkedDevice, PairCode } from "@/lib/types";

/** What the QR code holds: a link the TasksNG app (or the phone's camera) understands. */
export function pairUrl(code: string, mode: "pair" | "login") {
  const base = `${location.origin}/pair?c=${encodeURIComponent(code)}`;
  return mode === "login" ? `${base}&m=login` : base;
}

/** `ABCDEFGH` → `ABCD-EFGH`, easier to read out and type. */
export function formatCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** A code that expires: counts down and offers a new one. */
function useCode(start: () => Promise<PairCode>, active: boolean) {
  const [code, setCode] = useState<PairCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const refresh = useCallback(() => {
    setError(null);
    start()
      .then((c) => {
        setCode(c);
        setLeft(c.expiresIn);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [start]);
  useEffect(() => {
    if (active) refresh();
    else setCode(null);
  }, [active, refresh]);
  useEffect(() => {
    if (!code) return;
    const id = window.setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => window.clearInterval(id);
  }, [code]);
  return { code: left > 0 ? code : null, expired: !!code && left === 0, left, error, refresh };
}

function CodeCard({ code, url, left, expired, onRefresh }: { code: string | null; url: string | null; left: number; expired: boolean; onRefresh: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative rounded-xl border bg-white p-2 shadow-sm">
        {url ? <QrCode value={url} size={184} /> : <div className="size-[184px]" />}
        {(expired || !url) && (
          <div className="bg-background/85 absolute inset-0 flex items-center justify-center rounded-xl backdrop-blur-sm">
            {expired ? (
              <Button size="sm" variant="outline" onClick={onRefresh}>
                <RefreshCwIcon /> New code
              </Button>
            ) : (
              <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
            )}
          </div>
        )}
      </div>
      {code && (
        <div className="text-center">
          <div className="font-mono text-lg font-semibold tracking-[0.2em]">{formatCode(code)}</div>
          <div className="text-muted-foreground text-xs tabular-nums">
            Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </div>
        </div>
      )}
    </div>
  );
}

/** Settings → Phones: pair a phone, see and remove paired ones. */
export function PairingSection() {
  const [showing, setShowing] = useState(false);
  const [devices, setDevices] = useState<LinkedDevice[]>([]);
  const start = useCallback(() => api.pairStart(), []);
  const { code, expired, left, error, refresh } = useCode(start, showing);

  useEffect(() => {
    void api.listDevices().then(setDevices).catch(() => undefined);
    let off: (() => void) | undefined;
    void on<LinkedDevice[]>("devices", (list) => {
      setDevices((before) => {
        // A phone just scanned the code: close it.
        if (list.length > before.length) setShowing(false);
        return list;
      });
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">Phones</h3>
      <p className="text-muted-foreground text-sm">
        Pair the TasksNG Android app with this web app: it signs in with one scan, can sign in other browsers, and
        changes show up on both within seconds.
      </p>
      {devices.length > 0 && (
        <ul className="divide-y rounded-md border">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <SmartphoneIcon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{d.name}</div>
                <div className="text-muted-foreground text-xs">
                  Paired {formatDistanceToNowStrict(new Date(d.pairedAt), { addSuffix: true })} · seen{" "}
                  {formatDistanceToNowStrict(new Date(d.lastSeen), { addSuffix: true })}
                </div>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Unpair ${d.name}`}
                onClick={() => void api.unlinkDevice(d.id).then(setDevices)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {showing ? (
        <div className="bg-muted/30 grid gap-3 rounded-lg border p-4">
          <CodeCard code={code?.code ?? null} url={code ? pairUrl(code.code, "pair") : null} left={left} expired={expired} onRefresh={refresh} />
          <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
            <li>Open TasksNG on your phone (on the sign-in screen, or Settings → Pair with the web app).</li>
            <li>Tap “Scan the code” and point it at this code, or type the address and the code.</li>
          </ol>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button variant="ghost" size="sm" className="justify-self-end" onClick={() => setShowing(false)}>
            Done
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="outline" onClick={() => setShowing(true)}>
            <SmartphoneIcon /> Pair a phone
          </Button>
        </div>
      )}
    </section>
  );
}

/** The sign-in page's other way in: a phone that is signed in approves this browser. */
export function PhoneSignIn({ onCancel }: { onCancel: () => void }) {
  const start = useCallback(() => api.loginStart(), []);
  const { code, expired, left, error, refresh } = useCode(start, true);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!code?.secret) return;
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        await new Promise((r) => window.setTimeout(r, 1500));
        if (stopped) return;
        try {
          const out = await api.loginPoll(code.code, code.secret!);
          if ("snapshot" in out) {
            useStore.getState().signedIn(out);
            return;
          }
          if (out.status === "expired") return;
        } catch (e) {
          setProblem(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [code]);

  return (
    <div className="grid gap-4">
      <CodeCard code={code?.code ?? null} url={code ? pairUrl(code.code, "login") : null} left={left} expired={expired} onRefresh={refresh} />
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
        <li>Open TasksNG on your phone, signed in to your tasks.</li>
        <li>Go to Settings → Pair another, or sign in a browser, and scan this code.</li>
      </ol>
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2Icon className="size-3 animate-spin" /> This page signs in by itself once the phone approves.
      </p>
      {(error || problem) && <p className="text-destructive text-sm">{error ?? problem}</p>}
      <Button variant="ghost" onClick={onCancel}>
        Sign in with a password instead
      </Button>
    </div>
  );
}

/** Where a phone's camera lands after scanning a code without the app: hands it over to the app. */
export function PairLanding() {
  const params = new URLSearchParams(location.search);
  const code = params.get("c") ?? "";
  const mode = params.get("m") === "login" ? "login" : "pair";
  const appLink = `tasksng://pair?u=${encodeURIComponent(location.origin)}&c=${encodeURIComponent(code)}${mode === "login" ? "&m=login" : ""}`;
  return (
    <div className="bg-background relative flex h-full flex-col items-center justify-center overflow-hidden p-6">
      <Spotlight />
      <div className="relative z-10 grid w-full max-w-sm gap-5 text-center">
        <img src="/icon.svg" alt="" className="mx-auto size-14" />
        <h1 className="text-2xl font-semibold tracking-tight">Open this in the TasksNG app</h1>
        <p className="text-muted-foreground text-sm">
          {mode === "login"
            ? "A browser wants to sign in to your tasks. Approve it in the TasksNG app on this phone."
            : "This code pairs your phone with the TasksNG web app."}
        </p>
        {code && <div className="font-mono text-xl font-semibold tracking-[0.2em]">{formatCode(code)}</div>}
        <HoverBorderGradient
          as="a"
          href={appLink}
          containerClassName="mx-auto rounded-full"
          className="bg-background text-foreground flex items-center gap-2 px-5 py-2 text-sm font-medium"
        >
          <CheckIcon className="size-4" /> Open in TasksNG
        </HoverBorderGradient>
        <p className="text-muted-foreground text-xs">
          No app yet? Download the APK from the project's releases, install it, and scan the code again from inside the
          app.
        </p>
      </div>
    </div>
  );
}
