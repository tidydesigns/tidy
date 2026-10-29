import { readAnalyticsState, subscribeAnalyticsState } from "./analytics-state";
import { useEffect } from "react";
import type { AnalyticsAPI, AnalyticsState } from "@tidy/design/analytics";
/** Observe interaction timings only during current diagnostic consent, including its expiry. */
export function useDesktopDiagnostics(api: AnalyticsAPI | undefined) {
  useEffect(() => {
    if (!api) return;
    let observer: PerformanceObserver | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let revision = 0;
    let last = 0;
    let lastError = 0;
    let expiresAt = 0;
    const error = () => {
      if (Date.now() - lastError < 60_000) return;
      lastError = Date.now();
      void api.reportError().catch(() => {});
    };
    const apply = (state: AnalyticsState) => {
      if (disposed) return;
      clearTimeout(expiry);
      expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : 0;
      if (!state.diagnostics || !state.available || expiresAt <= Date.now()) {
        observer?.disconnect();
        observer = undefined;
        return;
      }
      expiry = setTimeout(refresh, Math.min(2147483647, Math.max(1, expiresAt - Date.now())));
      if (
        observer ||
        typeof PerformanceObserver === "undefined" ||
        !PerformanceObserver.supportedEntryTypes.includes("event")
      )
        return;
      observer = new PerformanceObserver((list) => {
        if (Date.now() >= expiresAt) {
          observer?.disconnect();
          observer = undefined;
          return;
        }
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
    };
    const refresh = () => {
      const current = revision;
      void readAnalyticsState(api)
        .then((state) => {
          if (current === revision) apply(state);
        })
        .catch(() => {
          observer?.disconnect();
          observer = undefined;
        });
    };
    const unsubscribe = subscribeAnalyticsState(api, (state) => {
      revision++;
      apply(state);
    });
    window.addEventListener("error", error);
    window.addEventListener("unhandledrejection", error);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
      clearTimeout(expiry);
      observer?.disconnect();
      window.removeEventListener("error", error);
      window.removeEventListener("unhandledrejection", error);
      window.removeEventListener("focus", refresh);
    };
  }, [api]);
}
