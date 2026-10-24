import { useCallback, useRef, useState, type SetStateAction } from "react";
import type { z } from "zod";
import {
  readNavigation,
  writeNavigation,
  type SessionValue,
} from "../../shared/navigation-storage";

export function useSessionState<T extends SessionValue>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      return readNavigation({ storage: sessionStorage, key, schema, fallback });
    } catch {
      return fallback;
    }
  });
  const current = useRef(value);
  const update = useCallback(
    (action: SetStateAction<T>) => {
      const next = typeof action === "function" ? action(current.current) : action;
      current.current = next;
      try {
        writeNavigation({ storage: sessionStorage, key, value: next });
      } catch {}
      setValue(next);
    },
    [key],
  );
  return [value, update] as const;
}
