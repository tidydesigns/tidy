import "server-only";
import { connectorOrigin } from "@/lib/connectors/http";
export function linearConfig() {
  return {
    clientId: process.env.LINEAR_CLIENT_ID ?? "",
    clientSecret: process.env.LINEAR_CLIENT_SECRET ?? "",
    origin: connectorOrigin(),
  };
}
export function linearConfigured() {
  const config = linearConfig();
  return Boolean(config.clientId && config.clientSecret && process.env.VAULT_ENCRYPTION_KEY);
}
