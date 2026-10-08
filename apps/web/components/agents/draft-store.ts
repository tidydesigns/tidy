"use client";
import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

const memory = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const empty = () => "";
function read(key: string) {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
/** Tab-local drafts survive a settings round trip without submitting or spending.
 * Include the Tidy user in the key so account switching never shows another draft. */
export function useAgentDraft(key: string) {
  const value = useSyncExternalStore(
    subscribe,
    useCallback(() => read(key), [key]),
    empty,
  );
  const update = useCallback(
    (next: SetStateAction<string>) => {
      const value = typeof next === "function" ? next(read(key)) : next;
      memory.set(key, value);
      try {
        if (value) window.sessionStorage.setItem(key, value);
        else window.sessionStorage.removeItem(key);
      } catch {
        /* Memory still preserves this page's draft. */
      }
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [value, update] as const;
}
