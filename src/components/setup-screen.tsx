import { ConnectForm } from "./connect-form";

export function SetupScreen() {
  return (
    <div className="bg-muted/30 flex h-full flex-col overflow-y-auto p-6">
      <div className="bg-background m-auto w-full max-w-md rounded-xl border p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/icon.svg" alt="" className="mb-4 size-14" />
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to TasksNG</h1>
          <p className="text-muted-foreground mt-1 text-sm">Connect to your Baikal server to get started.</p>
        </div>
        <ConnectForm />
      </div>
    </div>
  );
}
