import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToastViewport } from "@tidy/ui/toast";
import { App } from "../renderer/src/app/app";
import { useCloud } from "../renderer/src/features/cloud/use-cloud";
import { prepareDemo } from "./host";
import { LocalCanvas } from "../renderer/src/features/designs/local-canvas";
import { demoId, project, sampleDesign } from "./fixture";
import { prepareConversation } from "../renderer/src/features/threads/conversations";
import { PreviewArtwork } from "../renderer/src/features/designs/preview-renderers";
import type { PreparedWorkspace } from "../renderer/src/features/composer/machine-context";
import "@tidy/ui/fonts.css";
import "@tidy/ui/toast.css";
import "./demo.css";

const api = prepareDemo();
let ready = false;
const canvasView = new URLSearchParams(location.search).get("view") === "canvas";
if (!canvasView) document.documentElement.dataset.titlebar = "hidden";
const applyTheme = (theme: string | null) => {
  document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
};
applyTheme(
  new URLSearchParams(location.search).get("theme") ?? document.documentElement.style.colorScheme,
);
window.addEventListener("message", (event) => {
  if (
    event.source === parent &&
    event.origin === location.origin &&
    event.data?.type === "tidy-demo-status" &&
    ready
  )
    parent.postMessage({ type: "tidy-demo-ready" }, location.origin);
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
      if (
        event.target instanceof Element &&
        event.target.closest(
          'textarea, [contenteditable="true"], [role="textbox"], .queue-list, .message-markdown pre, .message-markdown table',
        )
      )
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
function Demo({ initial }: { initial: PreparedWorkspace }) {
  // No cloud API is supplied: the public example stays entirely in memory.
  const cloud = useCloud();
  useEffect(() => {
    ready = true;
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
      {canvasView ? <CanvasView /> : <App cloud={cloud} initial={initial} />}
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
// Prepare the in-memory project and initial views together, before React's first
// commit, so visitors never step through workspace/conversation loading screens.
async function start() {
  const [bootstrap, thread] = await Promise.all([
    api.bootstrap(),
    api.readThread(project.id, demoId(10)),
    // Failed optional chunks retain their view-level fallback/retry controls.
    // Canvas-only captures do not need either of these thread views.
    canvasView ? undefined : Promise.allSettled([prepareConversation(), PreviewArtwork.preload()]),
  ]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Demo initial={{ bootstrap, threads: [thread], relation: "matching" }} />
    </StrictMode>,
  );
}
void start().catch(() => {
  const root = document.getElementById("root")!;
  root.textContent = "Could not open the sample project. Reload the page to try again.";
  ready = true;
  parent.postMessage({ type: "tidy-demo-ready" }, location.origin);
});
