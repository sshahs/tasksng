import { useEffect, useState } from "react";
import { AlertCircleIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/lib/api";
import { isAndroid, isWindows } from "@/lib/platform";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ConnectForm({
  initial,
  submitLabel = "Connect",
  onConnected,
}: {
  initial?: { serverUrl: string; username: string; acceptInvalidCerts: boolean };
  submitLabel?: string;
  onConnected?: () => void;
}) {
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [insecure, setInsecure] = useState(initial?.acceptInvalidCerts ?? false);
  const [advanced, setAdvanced] = useState(initial?.acceptInvalidCerts ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The web version may be tied to one CalDAV server.
  const [fixedServer, setFixedServer] = useState<string | null>(null);

  useEffect(() => {
    if (!isWeb) return;
    void import("@/lib/http-backend").then(({ serverInfo }) =>
      serverInfo().then((info) => {
        if (info.caldavUrl) {
          setFixedServer(info.caldavUrl);
          setServerUrl(info.caldavUrl);
        }
      }),
    );
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().connect({ serverUrl, username, password, acceptInvalidCerts: insecure });
      onConnected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {fixedServer ? (
        <p className="text-muted-foreground text-sm">
          Sign in with your account on <span className="text-foreground font-medium">{hostOf(fixedServer)}</span>.
        </p>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="server">Server address</Label>
          <Input
            id="server"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://dav.example.com"
            autoFocus={!initial}
            autoComplete="url"
            spellCheck={false}
            required
          />
          <p className="text-muted-foreground text-xs">
            Your Baikal address. If it isn&apos;t found automatically, use the full URL ending in{" "}
            <code className="bg-muted rounded px-1">/dav.php</code>.
          </p>
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus={!!fixedServer && !initial}
          spellCheck={false}
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus={!!initial}
          required
        />
      </div>

      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs"
        onClick={() => setAdvanced((a) => !a)}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
        Advanced
      </button>
      {advanced && (
        <div className="bg-muted/50 flex items-start gap-3 rounded-md border p-3">
          <Switch id="insecure" checked={insecure} onCheckedChange={setInsecure} className="mt-0.5" />
          <div className="grid gap-1">
            <Label htmlFor="insecure">Accept invalid TLS certificates</Label>
            <p className="text-muted-foreground text-xs">
              {isWeb
                ? "Only for self-signed certificates on your own network. Prefer mounting your CA certificate into the TasksNG container instead (see the README)."
                : isAndroid
                ? "Only for self-signed certificates on your own network. TasksNG trusts the certificate authorities that come with Android, not ones you installed yourself."
                : isWindows
                ? "Only for self-signed certificates on your own network. Prefer installing your CA certificate in Windows instead — the app trusts the Windows certificate store."
                : "Only for self-signed certificates on your own network. Prefer adding your CA certificate to the system's trusted certificates instead (on NixOS: security.pki.certificateFiles)."}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border p-3 text-sm">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      <Button type="submit" disabled={busy || !serverUrl || !username || !password} className="mt-1">
        {busy && <Loader2Icon className="animate-spin" />}
        {busy ? "Connecting…" : submitLabel}
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        {isWeb
          ? "Your password is stored on this TasksNG server, which syncs with Baikal for you."
          : isAndroid
            ? "Your password is stored in TasksNG's private storage on this device."
            : isWindows
            ? "Your password is stored securely in Windows Credential Manager."
            : "Your password is stored in your desktop's keyring (GNOME Keyring, KWallet, KeePassXC…)."}
      </p>
    </form>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
