import { reportHandledError } from "@/lib/handled-error";
import { getWorkspace } from "@/lib/workspace/server";
import { authorizedClients } from "@/lib/mcp/authorizations";
import { McpOnboarding } from "./mcp-onboarding";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Connect your agent · Tidy" };

export default async function McpOnboardingPage({ searchParams }: PageProps<"/onboarding/mcp">) {
  const requestedId = (await searchParams).organizationId;
  const { organization, session } = await getWorkspace(
    typeof requestedId === "string" ? requestedId : undefined,
  );

  const baseUrl =
    process.env.BETTER_AUTH_URL ||
    (process.env.NODE_ENV === "development" ? "http://localhost:3000" : undefined);
  if (!baseUrl) throw new Error("BETTER_AUTH_URL is required for MCP onboarding.");
  const resourceUrl = new URL("/api/mcp", baseUrl).toString();

  // A transient read failure must not block setup. The client retries automatically.
  const initialClients = await authorizedClients(session.user.id, resourceUrl).catch((cause) => {
    reportHandledError(cause);
    return [];
  });
  return (
    <McpOnboarding
      key={organization.id}
      resourceUrl={resourceUrl}
      organizationId={organization.id}
      initialClients={initialClients}
    />
  );
}
