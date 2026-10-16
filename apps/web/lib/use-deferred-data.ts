"use client";

import { useEffect, useState } from "react";

type Result<T> = { status: "ready"; value: T } | { status: "pending" } | { status: "error" };

/** Observe optional server data without suspending the surrounding navigation. */
export function useDeferredData<T>(source: T | Promise<T>, keepPrevious = false): Result<T> {
  const [resolved, setResolved] = useState<{ source: Promise<T>; result: Result<T> }>();
  const promise =
    source && typeof source === "object" && "then" in source ? (source as Promise<T>) : undefined;
  useEffect(() => {
    if (!promise) return;
    let active = true;
    void promise.then(
      (value) => {
        if (active) setResolved({ source: promise, result: { status: "ready", value } });
      },
      () => {
        if (active) setResolved({ source: promise, result: { status: "error" } });
      },
    );
    return () => {
      active = false;
    };
  }, [promise]);
  if (!promise) return { status: "ready", value: source as T };
  return resolved &&
    (resolved.source === promise || (keepPrevious && resolved.result.status === "ready"))
    ? resolved.result
    : { status: "pending" };
}
