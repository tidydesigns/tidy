"use client";

import { useSyncExternalStore } from "react";

// Keep this breakpoint aligned with the editor's mobile CSS and md: utilities.
const query = "(width < 48rem)";

function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function useMobileEditor() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
