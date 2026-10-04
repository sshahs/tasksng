import { useState } from "react";
import { AlertCircleIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
      <div className="grid gap-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
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
              Only for self-signed certificates on your own network. Prefer installing your CA certificate in Windows
              instead — the app trusts the Windows certificate store.
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
        Your password is stored securely in Windows Credential Manager.
      </p>
    </form>
  );
}
