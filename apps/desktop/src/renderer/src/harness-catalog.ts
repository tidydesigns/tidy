import type { HarnessConnection, HarnessId } from "../../shared/contracts";
import type { HarnessDetails, HarnessSettings } from "../../shared/harness-settings";

export type HarnessCatalog = {
  connection: HarnessConnection;
  details?: HarnessDetails;
  loading: boolean;
  error?: string;
};

export type ModelSelection = {
  harness: HarnessId;
  settings: HarnessSettings;
};
