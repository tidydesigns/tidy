"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { isManagedImage } from "./image-display";
import { subscribeImage, type ImageLoad } from "./image-loading";

const loading: ImageLoad = { status: "loading" };

/** Retain the decoded variant of this asset until its replacement is decoded and committed. */
export function useLoadedImage(source: string, identity: string) {
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
    if (!isManagedImage(source) || source === store.source) return;
    let cancelled = false;
    let adopted = false;
    let release: (() => void) | undefined;
    const publish = (next: ImageLoad) => {
      store.state = next;
      for (const notify of store.listeners) notify();
    };
    // Coalesce variant requests while dragging. The existing image remains visible throughout.
    const timer = setTimeout(
      () => {
        release = subscribeImage(source, async (next) => {
          if (next.status === "loading") return;
          if (next.status === "ready") {
            try {
              const image = new Image();
              image.src = next.url;
              await image.decode();
            } catch {
              if (!cancelled && store.state.status !== "ready") publish({ status: "failed" });
              return;
            }
            if (cancelled) return;
            if (store.release) store.retired.push(store.release);
            store.release = release;
            store.source = source;
            adopted = true;
            publish(next);
          } else if (!cancelled && store.state.status !== "ready") publish(next);
        });
      },
      store.state.status === "ready" ? 120 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (!adopted) release?.();
    };
  }, [source, store]);
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
  return state;
}
