import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToastViewport } from "@tidy/ui/toast";
import { App } from "../renderer/src/app/app";
import { prepareDemo } from "./host";
import { LocalCanvas } from "../renderer/src/features/designs/local-canvas";
import { project, sampleDesign } from "./fixture";
import "@tidy/ui/fonts.css";
import "@tidy/ui/toast.css";
import "./demo.css";

prepareDemo();
const canvasView = new URLSearchParams(location.search).get("view") === "canvas";
if (!canvasView) document.documentElement.dataset.titlebar = "hidden";
const applyTheme = (theme: string | null) => {
  document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
};
applyTheme(new URLSearchParams(location.search).get("theme"));
window.addEventListener("message", (event) => {
  if (
    event.source === parent &&
    event.origin === location.origin &&
    event.data?.type === "tidy-demo-theme"
  )
    applyTheme(event.data.theme);
});
// Let visitors scroll past the thread preview. Once they open a canvas or an app
// overlay, leave all scrolling and gestures to the real desktop implementation.
if (
  !canvasView &&
  parent !== window &&
  new URLSearchParams(location.search).get("scroll") === "website"
) {
  window.addEventListener(
    "wheel",
    (event) => {
      if (document.querySelector(".desktop-canvas-focused, dialog[open], [popover]:popover-open"))
        return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? innerHeight
            : 1;
      parent.postMessage(
        { type: "tidy-demo-scroll", deltaY: event.deltaY * unit },
        location.origin,
      );
    },
    { capture: true, passive: false },
  );
}
/** The same FileEditor used by apps/web, with an example file and local persistence. */
function CanvasView() {
  const [design, setDesign] = useState(sampleDesign);
  const api = window.tidy;
  if (!api) return null;
  return (
    <main className="h-full" aria-label="Example design editor">
      <LocalCanvas
        api={api}
        projectId={project.id}
        initial={design}
        active
        initialPanelsOpen
        onBack={() => location.assign("/")}
        onUpdate={setDesign}
      />
    </main>
  );
}
function Demo() {
  useEffect(() => {
    parent.postMessage({ type: "tidy-demo-ready" }, location.origin);
    if (canvasView || innerWidth >= 700) return;
    const collapse = () => {
      const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Hide sidebar"]');
      if (toggle) {
        observer.disconnect();
        toggle.click();
      }
    };
    const observer = new MutationObserver(collapse);
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
    collapse();
    return () => observer.disconnect();
  }, []);
  return (
    <>
      {canvasView ? <CanvasView /> : <App />}
      {new URLSearchParams(location.search).get("view") === "desktop" && (
        <div className="capture-window-controls" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
      <ToastViewport />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
