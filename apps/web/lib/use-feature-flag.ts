"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";
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
