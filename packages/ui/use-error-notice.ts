"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { handleError } from "./errors";
import { dismissToast, showToast } from "./toast-store";

type Reporter = (error: unknown) => void;
type Notify = ((error: unknown, fallback?: string) => void) & { dismiss: () => void };
type Operation = { capture: Reporter; reported: boolean; toastId?: number };
const noop: Reporter = () => {};
const noReporter = () => noop;

/** Clear at operation start and keep the returned notifier in async handlers.
 * It retains that operation's reporter even when another action starts. */
export function useErrorNotice({
  initial = "",
  reporter = noReporter,
  presentation = "toast",
}: {
  initial?: string;
  reporter?: () => Reporter;
  presentation?: "toast" | "inline";
} = {}) {
  const [notice, setNotice] = useState<{ message: string; original?: unknown }>({
    message: initial,
  });
  const operation = useRef<Operation | null>(null);
  useEffect(() => {
    if (initial && presentation === "toast") showToast(initial);
  }, [initial, presentation]);
  const notify = useCallback(
    (error: unknown, fallback?: string): Notify => {
      const starting = error === "" && fallback === undefined;
      const current: Operation =
        starting || !operation.current
          ? { capture: reporter(), reported: false }
          : operation.current;
      operation.current = current;
      const apply = (value: unknown, copy?: string) => {
        const display = (message: string) => {
          if (operation.current === current) setNotice({ message, original: value });
          if (presentation === "toast") {
            if (current.toastId !== undefined) dismissToast(current.toastId);
            current.toastId = showToast(message, "error", undefined, current);
          }
        };
        if (typeof value === "string" && copy === undefined) {
          if (value) display(value);
        } else
          handleError(value, {
            fallback: copy ?? "Could not complete the action. Please try again.",
            report: (original) => {
              if (current.reported) return;
              current.reported = true;
              current.capture(original);
            },
            notify: display,
          });
      };
      apply.dismiss = () => {
        if (current.toastId !== undefined) dismissToast(current.toastId);
        if (operation.current === current) setNotice({ message: "" });
      };
      if (starting) setNotice({ message: "" });
      else apply(error, fallback);
      return apply;
    },
    [reporter, presentation],
  );
  return [notice.message, notify] as const;
}
