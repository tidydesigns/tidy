"use client";

import { useEffect, useMemo, useRef } from "react";
import { useEditorEvent } from "./use-editor-event";

/** Retain the newest preview, with at most one update per display frame. */
export function useFrameEvent<Args extends unknown[]>(callback: (...args: Args) => void) {
  const run = useEditorEvent(callback);
  const pending = useRef<Args | null>(null);
  const frame = useRef<number | null>(null);
  const event = useMemo(
    () => ({
      schedule(...args: Args) {
        pending.current = args;
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          const args = pending.current;
          pending.current = null;
          if (args) run(...args);
        });
      },
      cancel() {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        pending.current = null;
      },
    }),
    [run],
  );
  useEffect(() => event.cancel, [event]);
  return event;
}
