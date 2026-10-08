import { requireMcpAuth } from "@better-auth/mcp";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { auth } from "@/lib/auth";
import { hasMcpAuthorization } from "@/lib/mcp/authorizations";
import { readMcpRequest } from "@/lib/mcp/scopes";
import { instrumentMcpServer, McpActivity } from "@/lib/mcp/activity";
import { registerTidyTools } from "@/lib/mcp/registry";
import { meterMcpServer } from "@/lib/mcp/usage";
import { withMcpGrantContext, type McpGrant } from "@/lib/mcp/grant-context";
import { withMcpGrantOperation } from "@/lib/mcp/grant-operation";
import { runWithRequestSignal } from "@/lib/request-lifecycle";

export const runtime = "nodejs";
const resource = new URL(
  "/api/mcp",
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
).toString();
function buildServer(userId: string, clientId: string, grant: McpGrant) {
  const activity = new McpActivity({ userId, clientId });
  return registerTidyTools(
    meterMcpServer(
      instrumentMcpServer(new McpServer({ name: "Tidy canvas", version: "0.1.0" }), activity),
      userId,
      undefined,
      (organizationId, input, work) =>
        withMcpGrantOperation(grant, userId, organizationId, input, work),
    ),
    userId,
    activity,
  );
}

async function grantFailure(
  claims: Record<string, unknown>,
  scopes: readonly string[] = ["mcp:read"],
) {
  try {
    if (await hasMcpAuthorization(claims, resource, scopes)) return;
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Could not verify agent authorization. Try again." },
        id: null,
      },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  const error = new APIError("UNAUTHORIZED", {
    message: "Agent authorization has ended. Authorize again to reconnect.",
  });
  const challenge = createResourceServerChallenge(error, resource, {
    challengeScopes: [...scopes],
  });
  if (!challenge) throw error;
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: challenge.message }, id: null },
    { status: 401, headers: challenge.headers },
  );
}

export const POST = requireMcpAuth(
  auth,
  async (request, claims) => {
    const denied = await grantFailure(claims);
    if (denied) return denied;
    let parsed: Awaited<ReturnType<typeof readMcpRequest>>;
    try {
      parsed = await readMcpRequest(request);
    } catch {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Send a single valid JSON-RPC request within the size limit.",
          },
          id: null,
        },
        { status: 400 },
      );
    }
    const dispatch = async (bounded: Request) => {
      const denied = await grantFailure(claims, parsed.scopes);
      if (denied) return denied;
      const grant = { claims, resource, scopes: parsed.scopes };
      return runWithRequestSignal(request.signal, () =>
        withMcpGrantContext(grant, () =>
          createMcpHandler(() =>
            buildServer(claims.sub as string, claims.client_id as string, grant),
          ).fetch(bounded),
        ),
      );
    };
    // Connector and design permissions are separate. Verify every additional
    // scope and its persisted consent before dispatch, including connector reads.
    return parsed.scopes.length > 1
      ? requireMcpAuth(auth, dispatch, {
          resource,
          requiredScopes: parsed.scopes,
          challengeScopes: parsed.scopes,
        })(parsed.request)
      : dispatch(parsed.request);
  },
  { resource, requiredScopes: ["mcp:read"], challengeScopes: ["mcp:read"] },
);
