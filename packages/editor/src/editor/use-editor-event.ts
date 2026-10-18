"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable panel callbacks that always use the latest committed editor state. */
export function useEditorEvent<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const current = useRef(callback);
  useLayoutEffect(() => {
    current.current = callback;
  });
  return useCallback((...args: Args) => current.current(...args), []);
}
