import { useEffect } from "react";
import type { AnalyticsAPI } from "@tidy/design/analytics";
/** Content-free errors only; event-timing observation starts only after diagnostics opt-in. */
export function useDesktopDiagnostics(api: AnalyticsAPI | undefined) {
  useEffect(() => {
    if (!api) return;
    let observer: PerformanceObserver | undefined;
    let disposed = false;
    let last = 0;
    const error = () => {
      void api.reportError().catch(() => {});
    };
    const refresh = () => {
      void api
        .state()
        .then((state) => {
          if (disposed) return;
          if (!state.diagnostics) {
            observer?.disconnect();
            observer = undefined;
            return;
          }
          if (observer || !PerformanceObserver.supportedEntryTypes.includes("event")) return;
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (Date.now() - last < 60_000) continue;
              last = Date.now();
              const duration = entry.duration;
              void api
                .performance(
                  duration < 100
                    ? "under_100ms"
                    : duration < 1000
                      ? "under_1s"
                      : duration < 5000
                        ? "under_5s"
                        : "over_5s",
                )
                .catch(() => {});
            }
          });
          observer.observe({
            type: "event",
            buffered: false,
            durationThreshold: 16,
          } as PerformanceObserverInit);
        })
        .catch(() => {});
    };
    window.addEventListener("error", error);
    window.addEventListener("unhandledrejection", error);
    window.addEventListener("focus", refresh);
    window.addEventListener("tidy-privacy-change", refresh);
    refresh();
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("error", error);
      window.removeEventListener("unhandledrejection", error);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("tidy-privacy-change", refresh);
    };
  }, [api]);
}
