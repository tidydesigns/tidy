"use server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { actionError } from "@/lib/action-error";
import { authorizedClients, revokeMcpAuthorization } from "@/lib/mcp/authorizations";

export async function revokeAgent(clientId: string) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return { error: "Sign in to revoke agent access." };
    await revokeMcpAuthorization(session.user.id, clientId);
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not revoke agent access.") };
  }
}
export async function checkAuthorizedAgents() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to check agent access." };
  return {
    clients: await authorizedClients(
      session.user.id,
      new URL("/api/mcp", process.env.BETTER_AUTH_URL ?? "http://localhost:3000").toString(),
    ),
  };
}
