import { getWorkspace } from "@/lib/workspace/server";
import { McpOnboarding } from "./mcp-onboarding";

export default async function McpOnboardingPage({ searchParams }: PageProps<"/onboarding/mcp">) {
  const requestedId = (await searchParams).organizationId;
  await getWorkspace(typeof requestedId === "string" ? requestedId : undefined);

  const resourceUrl = new URL(
    "/api/mcp",
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  ).toString();

  return <McpOnboarding resourceUrl={resourceUrl} />;
}
