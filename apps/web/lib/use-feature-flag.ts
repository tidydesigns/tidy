"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { FLAGS_OFF, type FeatureFlag, type FunctionalFlags } from "./feature-flags";

const FlagContext = createContext<FunctionalFlags>(FLAGS_OFF);

/** Share only server-evaluated booleans; no SDK, browser storage or consent state. */
export function FeatureFlagsProvider({
  flags,
  children,
}: {
  flags: FunctionalFlags;
  children: ReactNode;
}) {
  return createElement(FlagContext.Provider, { value: flags }, children);
}

export function useFeatureFlag(flag: FeatureFlag): boolean {
  return useContext(FlagContext)[flag] === true;
}

/** Optional editor controls load after the canvas, and remain off until resolved.
 * A new request never inherits enabled flags from the previous file.
 */
export function DeferredFeatureFlagsProvider({
  flags,
  children,
}: {
  flags: Promise<FunctionalFlags>;
  children: ReactNode;
}) {
  const [resolved, setResolved] = useState<{
    source: Promise<FunctionalFlags>;
    value: FunctionalFlags;
  }>();
  useEffect(() => {
    let active = true;
    void flags.then(
      (value) => {
        if (active) setResolved({ source: flags, value });
      },
      () => {
        if (active) setResolved({ source: flags, value: FLAGS_OFF });
      },
    );
    return () => {
      active = false;
    };
  }, [flags]);
  return createElement(
    FlagContext.Provider,
    { value: resolved?.source === flags ? resolved.value : FLAGS_OFF },
    children,
  );
}
