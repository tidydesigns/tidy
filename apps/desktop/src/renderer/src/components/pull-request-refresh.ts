const listeners = new Map<(force: boolean) => void, number>();
let stop: (() => void) | undefined;

/** One foreground clock and one focus handler, regardless of how many PRs are visible. */
export function subscribePullRequestRefresh(listener: (force: boolean) => void) {
  listeners.set(listener, (listeners.get(listener) ?? 0) + 1);
  if (!stop) {
    let queued = false;
    let disposed = false;
    const refresh = (force: boolean) => {
      if (document.visibilityState === "hidden") return;
      for (const notify of listeners.keys()) notify(force);
    };
    const focused = () => {
      if (queued) return;
      queued = true;
      // Focus and visibilitychange commonly describe the same foreground transition.
      queueMicrotask(() => {
        queued = false;
        if (!disposed) refresh(true);
      });
    };
    const timer = setInterval(() => refresh(false), 15_000);
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    stop = () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", focused);
    };
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    const remaining = (listeners.get(listener) ?? 1) - 1;
    if (remaining) listeners.set(listener, remaining);
    else listeners.delete(listener);
    if (!listeners.size) {
      stop?.();
      stop = undefined;
    }
  };
}
