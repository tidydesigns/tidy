"use client";

import { useSyncExternalStore } from "react";
import { featureFlagEnabled, subscribeFeatureFlags, type FeatureFlag } from "./feature-flags";

const serverSnapshot = () => false;

export function useFeatureFlag(flag: FeatureFlag): boolean {
  return useSyncExternalStore(
    subscribeFeatureFlags,
    () => featureFlagEnabled(flag),
    serverSnapshot,
  );
}
