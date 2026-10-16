import { requireMcpAuth } from "@better-auth/mcp";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { auth } from "@/lib/auth";
import { hasMcpAuthorization } from "@/lib/mcp/authorizations";
import { readMcpRequest } from "@/lib/mcp/scopes";
import { instrumentMcpServer, McpActivity } from "@/lib/mcp/activity";
import { registerTidyTools } from "@/lib/mcp/registry";
import { instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { meterMcpServer } from "@/lib/mcp/usage";
import { currentMcpGrant, withMcpGrantContext, type McpGrant } from "@/lib/mcp/grant-context";
import { withMcpGrantOperation } from "@/lib/mcp/grant-operation";
import { isMcpReadOperation } from "@/lib/mcp/execution-policy";
import { runWithRequestSignal } from "@/lib/request-lifecycle";
import { traceOperation } from "@/lib/trace-context";

export const runtime = "nodejs";
const resource = new URL(
  "/api/mcp",
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
).toString();
// Ask for design editing at consent; read-only grants still authorize reads.
const connectionScopes = ["mcp:read", "mcp:write"];

function buildServer(userId: string, clientId: string, grant: McpGrant) {
  const activity = new McpActivity({ userId, clientId });
  return registerTidyTools(
    meterMcpServer(
      instrumentMcpAnalytics(
        instrumentMcpServer(
          new McpServer(
            { name: "Tidy canvas", version: "0.1.0" },
            {
              cacheHints: {
                "tools/list": { ttlMs: 300_000, cacheScope: "private" },
                "resources/list": { ttlMs: 300_000, cacheScope: "private" },
                "resources/templates/list": { ttlMs: 300_000, cacheScope: "private" },
              },
            },
          ),
          activity,
        ),
        userId,
      ),
      userId,
      undefined,
      (organizationId, input, work, operation) =>
        withMcpGrantOperation(
          grant,
          userId,
          organizationId,
          input,
          work,
          isMcpReadOperation(operation),
        ),
    ),
    userId,
    activity,
  );
}

// The handler is shared; the SDK still constructs a fresh server and transport
// for each request. Actor closures and grants never survive their request.
const mcpHandler = createMcpHandler(() => {
  const grant = currentMcpGrant();
  if (!grant) throw new Error("Missing authenticated MCP context.");
  return buildServer(grant.claims.sub as string, grant.claims.client_id as string, grant);
});

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
    challengeScopes: [...new Set([...connectionScopes, ...scopes])],
  });
  if (!challenge) throw error;
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: challenge.message }, id: null },
    { status: 401, headers: challenge.headers },
  );
}

const authenticatedPost = requireMcpAuth(
  auth,
  async (request, claims) => {
    let parsed: Awaited<ReturnType<typeof readMcpRequest>>;
    try {
      parsed = await traceOperation("mcp.request_body", () => readMcpRequest(request));
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
    // Signature, audience, expiry and DPoP are verified once by the outer
    // middleware. Re-verifying the same DPoP proof would also look like replay.
    const tokenScopes = new Set(typeof claims.scope === "string" ? claims.scope.split(" ") : []);
    if (parsed.scopes.some((scope) => !tokenScopes.has(scope)))
      throw createInsufficientScopeError(parsed.scopes);
    const denied = await traceOperation("mcp.authorization", () =>
      grantFailure(claims, parsed.scopes),
    );
    if (denied) return denied;
    const grant = { claims, resource, scopes: parsed.scopes };
    return withMcpGrantContext(grant, () =>
      mcpHandler.fetch(parsed.request, { parsedBody: parsed.parsedBody }),
    );
  },
  { resource, requiredScopes: ["mcp:read"], challengeScopes: connectionScopes },
);

export function POST(request: Request) {
  return runWithRequestSignal(request.signal, () =>
    traceOperation("mcp.request", () => authenticatedPost(request)),
  );
}
