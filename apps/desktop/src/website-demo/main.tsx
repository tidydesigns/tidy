import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ToastViewport } from "@tidy/ui/toast";
import { App } from "../renderer/src/app/app";
import { prepareDemo } from "./host";
import "@tidy/ui/fonts.css";
import "@tidy/ui/toast.css";
import "./demo.css";

prepareDemo();
document.documentElement.dataset.titlebar = "hidden";
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
// A wheel event cannot bubble out of an iframe. Relay ordinary vertical scrolling
// before the real editor or transcript consumes it; keep deliberate canvas gestures.
if (parent !== window && new URLSearchParams(location.search).get("scroll") === "website") {
  window.addEventListener(
    "wheel",
    (event) => {
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
function Demo() {
  useEffect(() => {
    parent.postMessage({ type: "tidy-demo-ready" }, location.origin);
    if (innerWidth >= 700) return;
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
      <App />
      <ToastViewport />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
