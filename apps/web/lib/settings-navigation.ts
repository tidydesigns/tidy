export type SettingsTab =
  | "profile"
  | "preferences"
  | "privacy"
  | "organization"
  | "members"
  | "connectors"
  | "billing"
  | "agents";

export const settingsLabels: Record<SettingsTab, string> = {
  profile: "Profile",
  preferences: "Preferences",
  privacy: "Privacy",
  organization: "Organization",
  members: "Members",
  connectors: "Connectors",
  billing: "Billing",
  agents: "Agents",
};

export function settingsTab(value: unknown): SettingsTab | undefined {
  if (value === "settings") return "organization";
  if (value === "github") return "connectors";
  return typeof value === "string" && Object.hasOwn(settingsLabels, value)
    ? (value as SettingsTab)
    : undefined;
}

export function settingsTabs(billing: boolean, agents: boolean): SettingsTab[] {
  return [
    "profile",
    "preferences",
    "privacy",
    "organization",
    "members",
    "connectors",
    ...(billing ? ["billing" as const] : []),
    ...(agents ? ["agents" as const] : []),
  ];
}
