import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastViewport } from "@tidy/ui/toast";
import "@tidy/ui/toast.css";
import { MachineWorkspace } from "./app/machine-workspace";
import { HarnessUpdateNotices } from "./features/harnesses/harness-updates";
import "@tidy/ui/fonts.css";
import "./styles.css";
import { initializeTheme } from "./theme";

initializeTheme();

if (import.meta.env.DEV && !window.tidy) await import("./platform/browser-api");

// Apply the native controls' inset before the first render to avoid a layout shift.
if (window.tidy?.customTitlebar) document.documentElement.dataset.titlebar = "hidden";
window.tidy?.onWindowFullscreen?.((fullscreen) => {
  document.documentElement.toggleAttribute("data-window-fullscreen", fullscreen);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MachineWorkspace />
    <ToastViewport>
      <HarnessUpdateNotices api={window.tidy} />
    </ToastViewport>
  </StrictMode>,
);
