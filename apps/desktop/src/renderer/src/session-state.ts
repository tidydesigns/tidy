import { useCallback, useRef, useState, type SetStateAction } from "react";
import type { z } from "zod";
import { readNavigation } from "../../shared/navigation-state";

export function useSessionState<T>(key: string, schema: z.ZodType<T>, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      return readNavigation(sessionStorage, key, schema, fallback);
    } catch {
      return fallback;
    }
  });
  const current = useRef(value);
  const update = useCallback(
    (action: SetStateAction<T>) => {
      const next =
        typeof action === "function" ? (action as (previous: T) => T)(current.current) : action;
      current.current = next;
      try {
        sessionStorage.setItem(`tidy:navigation:${key}`, JSON.stringify(next));
      } catch {}
      setValue(next);
    },
    [key],
  );
  return [value, update] as const;
}
