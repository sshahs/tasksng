import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { windowLabel } from "./lib/api";
import "./index.css";

// The quick add window loads only what it needs.
const Root =
  location.pathname === "/pair"
    ? lazy(() => import("./components/pairing").then((m) => ({ default: m.PairLanding })))
    : windowLabel() === "quick-add"
    ? lazy(() => import("./quick-add-window").then((m) => ({ default: m.QuickAddWindow })))
    : lazy(() => import("./App"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
