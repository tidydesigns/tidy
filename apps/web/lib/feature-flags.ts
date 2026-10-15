export const featureFlagKeys = [
  "mcp-pi-gemini",
  "github-connector",
  "settings-connectors",
] as const;
export type FeatureFlag = (typeof featureFlagKeys)[number];
export type FunctionalFlags = Readonly<Record<FeatureFlag, boolean>>;

export const FLAGS_OFF: FunctionalFlags = Object.freeze({
  "mcp-pi-gemini": false,
  "github-connector": false,
  "settings-connectors": false,
});
