import type { Client } from "pg";
import { z } from "zod";
import type { LinearToken } from "../linear/client";
import { seal } from "../connectors/crypto";

const graphqlRequestSchema = z.object({ query: z.string() });

// Disposable MCP database only; no provider traffic or real credentials.
export async function linearReadFixture(
  admin: Client,
  beforeTeams: () => Promise<void> = async () => {},
) {
  const connectionId = "10000000-0000-4000-8000-000000000001";
  const workspaceId = "20000000-0000-4000-8000-000000000001";
  const userId = "30000000-0000-4000-8000-000000000001";
  const previousKey = process.env.VAULT_ENCRYPTION_KEY;
  process.env.VAULT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const scope = "mcp:read mcp:write linear:read";
  await admin.query('update "oauthClient" set "scopes"=$1 where "clientId"=\'client-a\'', [
    JSON.stringify(scope.split(" ")),
  ]);
  await admin.query('update "oauthConsent" set "scopes"=$1 where "id"=\'consent-a\'', [
    JSON.stringify(scope.split(" ")),
  ]);
  const token = {
    access_token: "fixture",
    refresh_token: "fixture-refresh",
    expires_in: 86400,
    scope: "read",
  } satisfies LinearToken;
  await admin.query(
    `insert into "connectorAccount" ("id","provider","userId","externalWorkspaceId","externalUserId","workspaceName","accountName","credentials","scopes","expiresAt")
     values ($1,'linear','alice',$2,$3,'Fixture','Fixture',$4,array['read'],now()+interval '1 day');`,
    [connectionId, workspaceId, userId, seal(JSON.stringify(token), `linear:alice:${workspaceId}`)],
  );
  await admin.query(
    'insert into "connectorConnection" ("id","accountId","organizationId") values ($1,$1,\'org-a\')',
    [connectionId],
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input) !== "https://api.linear.app/graphql") return previousFetch(input, init);
      if (typeof init?.body !== "string") throw new Error("Expected fixture GraphQL JSON body.");
      const body = graphqlRequestSchema.parse(JSON.parse(init.body));
      if (body.query.includes("TidyIdentity"))
        return Response.json({
          data: {
            viewer: { id: userId, name: "Fixture" },
            organization: { id: workspaceId, name: "Fixture" },
          },
        });
      if (body.query.includes("TidyTeams")) {
        await beforeTeams();
        return Response.json({
          data: { teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      throw new Error("Unexpected fixture provider operation");
    },
    { preconnect: previousFetch.preconnect },
  );
  return {
    scope,
    params: { name: "linear_list_teams", arguments: { organizationId: "org-a", connectionId } },
    restore() {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.VAULT_ENCRYPTION_KEY;
      else process.env.VAULT_ENCRYPTION_KEY = previousKey;
    },
  };
}
