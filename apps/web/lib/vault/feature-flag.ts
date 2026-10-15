import "server-only";
import { cache } from "react";

// Access to product features must not depend on optional analytics consent.
// Keep Vault off until its independent functional rollout is enabled.
export const vaultEnabled = cache(async (_userId: string): Promise<boolean> => {
  void _userId;
  return process.env.VAULT_ENABLED === "1";
});
