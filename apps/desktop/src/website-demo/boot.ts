// Keep the initial iframe lightweight on mobile, where the site shows a capture.
// On desktop it starts independently of the site's React hydration and scrolling.
const embedded =
  parent !== window && new URLSearchParams(location.search).get("scroll") === "website";
// Use the website viewport, not the narrower inset app window.
let viewport = matchMedia("(min-width: 801px)");
if (embedded) {
  try {
    viewport = parent.matchMedia("(min-width: 801px)");
  } catch {
    /* Cross-origin embed. */
  }
}
let started = false;
function start() {
  if (started || (embedded && !viewport.matches)) return;
  started = true;
  viewport.removeEventListener("change", start);
  let theme = new URLSearchParams(location.search).get("theme");
  if (!theme && embedded) {
    try {
      theme = parent.document.documentElement.dataset.theme ?? null;
    } catch {
      /* Standalone cross-origin embeds use the system theme. */
    }
  }
  document.documentElement.style.colorScheme =
    theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  void import("./main").catch(() => {
    document.getElementById("root")!.textContent =
      "Could not open the sample project. Reload the page to try again.";
    const reportFailure = () => parent.postMessage({ type: "tidy-demo-ready" }, location.origin);
    window.addEventListener("message", (event) => {
      if (
        event.origin === location.origin &&
        event.source === parent &&
        event.data?.type === "tidy-demo-status"
      )
        reportFailure();
    });
    reportFailure();
  });
}
viewport.addEventListener("change", start);
start();
