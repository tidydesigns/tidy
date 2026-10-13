"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { isManagedImage } from "./image-display";
import { subscribeImage, type ImageLoad, type ImagePool } from "./image-loading";

const loading: ImageLoad = { status: "loading" };

/** Retain the decoded variant of this asset until its replacement is decoded and committed. */
export function useLoadedImage(source: string, identity: string, enabled = true, pool?: ImagePool) {
  const store = useMemo(() => {
    // Identity includes the source version, so replacing an asset never shows stale pixels.
    void identity;
    return {
      state: loading,
      source: "",
      release: undefined as (() => void) | undefined,
      retired: [] as (() => void)[],
      listeners: new Set<() => void>(),
    };
  }, [identity]);
  const subscribe = useCallback(
    (notify: () => void) => {
      store.listeners.add(notify);
      return () => {
        store.listeners.delete(notify);
      };
    },
    [store],
  );
  const snapshot = useCallback(() => store.state, [store]);
  const state = useSyncExternalStore(subscribe, snapshot, () => loading);
  useEffect(() => {
    if (!enabled) {
      store.release?.();
      for (const release of store.retired.splice(0)) release();
      store.release = undefined;
      store.source = "";
      store.state = loading;
      for (const notify of store.listeners) notify();
      return;
    }
    if (!isManagedImage(source) || source === store.source) return;
    let cancelled = false;
    let adopted = false;
    let release: (() => void) | undefined;
    const publish = (next: ImageLoad) => {
      store.state = next;
      for (const notify of store.listeners) notify();
    };
    const requestedWidth = (value: string) =>
      Number(new URL(value, "https://design.invalid").searchParams.get("width")) || Infinity;
    // Upgrade immediately; delay reductions to avoid churn around zoom thresholds.
    // The existing decoded image remains visible until its replacement is ready.
    const delay =
      store.state.status !== "ready"
        ? 0
        : pool
          ? requestedWidth(source) > requestedWidth(store.source)
            ? 0
            : 500
          : 120;
    const timer = setTimeout(() => {
      release = (pool?.subscribe ?? subscribeImage)(source, (next) => {
        if (next.status === "loading") return;
        if (next.status === "ready") {
          if (cancelled) return;
          if (store.release) store.retired.push(store.release);
          store.release = release;
          store.source = source;
          adopted = true;
          publish(next);
        } else if (!cancelled && store.state.status !== "ready") publish(next);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (!adopted) release?.();
    };
  }, [source, store, enabled, pool]);
  useLayoutEffect(() => {
    for (const release of store.retired.splice(0)) release();
  }, [state, store]);
  useEffect(
    () => () => {
      store.release?.();
      for (const release of store.retired.splice(0)) release();
      store.release = undefined;
      store.source = "";
      store.state = loading;
    },
    [store],
  );
  return enabled ? state : loading;
}
