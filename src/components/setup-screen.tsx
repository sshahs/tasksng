import { ConnectForm } from "./connect-form";

export function SetupScreen() {
  return (
    <div className="bg-muted/30 flex h-full flex-col overflow-y-auto p-6">
      {/* The card rises in, the logo pops, the words follow. */}
      <div className="bg-background animate-rise m-auto w-full max-w-md rounded-xl border p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src="/icon.svg"
            alt=""
            className="animate-in zoom-in-50 fade-in-0 fill-mode-both mb-4 size-14 delay-150 duration-500 ease-(--ease-pop)"
          />
          <h1 className="animate-rise text-2xl font-semibold tracking-tight [animation-delay:200ms]">Welcome to TasksNG</h1>
          <p className="text-muted-foreground animate-rise mt-1 text-sm [animation-delay:260ms]">
            Connect to your Baikal server to get started.
          </p>
        </div>
        <div className="animate-rise [animation-delay:320ms]">
          <ConnectForm />
        </div>
      </div>
    </div>
  );
}
