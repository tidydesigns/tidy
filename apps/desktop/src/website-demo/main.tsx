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
