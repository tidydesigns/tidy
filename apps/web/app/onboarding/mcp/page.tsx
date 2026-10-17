import { getWorkspace } from "@/lib/workspace/server";
import { McpOnboarding } from "./mcp-onboarding";

export default async function McpOnboardingPage({ searchParams }: PageProps<"/onboarding/mcp">) {
  const requestedId = (await searchParams).organizationId;
  await getWorkspace(typeof requestedId === "string" ? requestedId : undefined);

  const baseUrl =
    process.env.BETTER_AUTH_URL ||
    (process.env.NODE_ENV === "development" ? "http://localhost:3000" : undefined);
  if (!baseUrl) throw new Error("BETTER_AUTH_URL is required for MCP onboarding.");
  const resourceUrl = new URL("/api/mcp", baseUrl).toString();

  return <McpOnboarding resourceUrl={resourceUrl} />;
}
