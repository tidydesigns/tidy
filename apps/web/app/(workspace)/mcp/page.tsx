import type { Metadata } from "next";
import { mcpPage } from "@/components/workspace/page-layout";
import { getWorkspace } from "@/lib/workspace/server";
import { authorizedClients } from "@/lib/mcp/authorizations";
import { McpConnection } from "@/app/mcp/mcp-connection";
import { functionalFeatureFlags } from "@/lib/functional-feature-flags";
import { DeferredFeatureFlagsProvider } from "@/lib/use-feature-flag";

export const metadata: Metadata = { title: "MCP · Tidy" };

export default async function McpPage() {
  const resourceUrl = new URL(
    "/api/mcp",
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  ).toString();
  const { session, organization } = await getWorkspace();
  const clients = authorizedClients(session.user.id, resourceUrl);
  const flags = functionalFeatureFlags();

  return (
    <DeferredFeatureFlagsProvider flags={flags}>
      <main className={mcpPage} data-page-content="mcp">
        <McpConnection
          clients={clients}
          resourceUrl={resourceUrl}
          organizationId={organization.id}
        />
      </main>
    </DeferredFeatureFlagsProvider>
  );
}
