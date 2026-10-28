import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { z } from "zod";
import { readNavigation, writeNavigation, type SessionValue } from "./navigation-storage";

export const NavigationScope = createContext("");

export function useSessionState<T extends SessionValue>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  initial?: T,
) {
  const scope = useContext(NavigationScope);
  key = scope ? `${scope}:${key}` : key;
  const [value, setValue] = useState<T>(() => {
    if (initial !== undefined) return initial;
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
