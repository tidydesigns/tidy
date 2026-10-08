/** Browser-safe catalog. Provider services and credentials stay on the server. */
export const connectorProviders = [
  {
    id: "github",
    name: "GitHub",
    icon: "/connectors/github.svg",
    description: "Connect repositories and review pull requests alongside your designs.",
  },
  {
    id: "linear",
    name: "Linear",
    icon: "/connectors/linear.svg",
    description: "Give your agents access to issues, comments and teams in Linear.",
  },
] as const;
export type ConnectorProvider = (typeof connectorProviders)[number]["id"];
export type ConnectorConnection = {
  id: string;
  accountId: string;
  provider: string;
  workspaceName: string;
  accountName: string;
  state: "connected" | "reconnect";
};
export type ConnectorStatus = {
  ready: boolean;
  configured: boolean;
  connections: ConnectorConnection[];
  error: string | null;
};
export function connectorsHref(provider?: ConnectorProvider) {
  return `/settings?tab=connectors${provider ? `&connector=${provider}` : ""}`;
}
