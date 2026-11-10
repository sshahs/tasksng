import { useEffect, useState } from "react";
import { SmartphoneIcon } from "lucide-react";

import { AuroraBackground } from "@/components/aceternity/aurora-background";
import { HoverBorderGradient } from "@/components/aceternity/hover-border-gradient";
import { TextGenerateEffect } from "@/components/aceternity/text-generate-effect";
import { PhoneSignIn } from "@/components/pairing";
import { isWeb } from "@/lib/api";
import { ConnectForm } from "./connect-form";

export function SetupScreen() {
  const [pairing, setPairing] = useState(false);
  const [phone, setPhone] = useState(false);

  useEffect(() => {
    if (!isWeb) return;
    void import("@/lib/http-backend").then(({ serverInfo }) => serverInfo().then((i) => setPairing(!!i.pairing)));
  }, []);

  return (
    <AuroraBackground className="h-full overflow-y-auto bg-zinc-50 p-6 dark:bg-zinc-950">
      {/* The card rises in, the logo pops, the words follow. */}
      <div className="bg-background/85 animate-rise relative z-10 m-auto w-full max-w-md rounded-2xl border p-8 shadow-xl backdrop-blur-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src="/icon.svg"
            alt=""
            className="animate-in zoom-in-50 fade-in-0 fill-mode-both mb-4 size-14 delay-150 duration-500 ease-(--ease-pop)"
          />
          <h1 className="text-2xl font-semibold tracking-tight">
            <TextGenerateEffect words="Welcome to TasksNG" className="text-2xl font-semibold" duration={0.4} />
          </h1>
          <p className="text-muted-foreground animate-rise mt-1 text-sm [animation-delay:260ms]">
            {phone ? "Sign in with the TasksNG app on your phone." : "Connect to your Baikal server to get started."}
          </p>
        </div>
        <div className="animate-rise [animation-delay:320ms]">
          {phone ? (
            <PhoneSignIn onCancel={() => setPhone(false)} />
          ) : (
            <>
              <ConnectForm />
              {pairing && (
                <>
                  <div className="text-muted-foreground my-5 flex items-center gap-3 text-xs">
                    <div className="bg-border h-px flex-1" /> or <div className="bg-border h-px flex-1" />
                  </div>
                  <HoverBorderGradient
                    as="button"
                    type="button"
                    onClick={() => setPhone(true)}
                    containerClassName="w-full rounded-lg"
                    className="bg-background text-foreground flex w-full items-center justify-center gap-2 px-4 py-2 text-sm font-medium"
                  >
                    <SmartphoneIcon className="size-4" /> Sign in with your phone
                  </HoverBorderGradient>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </AuroraBackground>
  );
}
