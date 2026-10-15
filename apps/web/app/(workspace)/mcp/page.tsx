import { mcpPage } from "@/components/workspace/page-layout";
import { getWorkspace } from "@/lib/workspace/server";
import { authorizedClients } from "@/lib/mcp/authorizations";
import { McpConnection } from "@/app/mcp/mcp-connection";
import { functionalFeatureFlags } from "@/lib/functional-feature-flags";
import { FeatureFlagsProvider } from "@/lib/use-feature-flag";

export default async function McpPage() {
  const { session } = await getWorkspace();

  const resourceUrl = new URL(
    "/api/mcp",
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  ).toString();
  const [clients, flags] = await Promise.all([
    authorizedClients(session.user.id, resourceUrl),
    functionalFeatureFlags(),
  ]);

  return (
    <FeatureFlagsProvider flags={flags}>
      <main className={mcpPage} data-page-content="mcp">
        <McpConnection clients={clients} resourceUrl={resourceUrl} />
      </main>
    </FeatureFlagsProvider>
  );
}
