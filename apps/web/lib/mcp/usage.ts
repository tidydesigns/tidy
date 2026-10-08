import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "@/lib/db";
import type { PoolClient } from "pg";
import { currentMcpGrant } from "./grant-context";
import { McpGrantError, requireMcpGrant } from "./authorizations";
import { PublicActionError } from "@/lib/security/public-error";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { planLimitMessage } from "@/lib/billing/plans";
import { record } from "./activity-summary";

class McpUsageAccessError extends PublicActionError {}

/** Resolve the tool's actual workspace before reserving a call. Never fall back
 * to another workspace when a supplied target is missing or inaccessible. */
export async function consumeMcpCall(userId: string, input: Record<string, unknown>) {
  const denied = () =>
    new McpUsageAccessError(
      "Workspace not found or access denied. Join or create a workspace in Tidy first.",
    );
  const { explicit, selectors, parent } = mcpTargets(input);
  let organizationId: string | undefined;
  if (selectors[0]) {
    const { kind, id } = selectors[0];
    const result = await db.query<{ organizationId: string }>(
      `select "organizationId" from "${parent(kind)}" where "id"=$1 ${kind === "import" ? 'and "userId"=$2' : "and $2::text is not null"}`,
      [id, userId],
    );
    organizationId = result.rows[0]?.organizationId;
  } else if (typeof explicit === "string") organizationId = explicit;
  else {
    // Default only for target-free guidance/discovery; exact roles and verified identity.
    organizationId = (
      await db.query<{ organizationId: string }>(
        `select m."organizationId" from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
       where m."userId"=$1 and m."role" in ${VIEW_ROLES_SQL}
       order by (m."role"='owner') desc,m."createdAt",m."organizationId" limit 1`,
        [userId],
      )
    ).rows[0]?.organizationId;
  }
  if (!organizationId || (explicit !== undefined && explicit !== organizationId)) throw denied();
  const client = await db.connect();
  try {
    await client.query("begin");
    // Same quota-before-authority order as product writes. Discovery retains no locks.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    const grant = currentMcpGrant();
    if (grant) await requireMcpGrant(client, grant, userId);
    await retainMcpTargets(client, userId, organizationId, input);
    // Prices are enrolled by operators; metering never writes the billing catalog.
    await client.query('select "consumeOrganizationMcpCall"($1,$2)', [userId, organizationId]);
    await client.query("commit");
    return organizationId;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function mcpTargets(input: Record<string, unknown>) {
  const denied = () =>
    new McpUsageAccessError(
      "Workspace not found or access denied. Join or create a workspace in Tidy first.",
    );
  const valid = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 120;
  for (const key of [
    "organization_id",
    "organizationId",
    "import_id",
    "file_id",
    "review_id",
    "folder_id",
  ])
    if (
      input[key] !== undefined &&
      !(key === "folder_id" && input[key] === null) &&
      !valid(input[key])
    )
      throw denied();
  if (
    input.organization_id !== undefined &&
    input.organizationId !== undefined &&
    input.organization_id !== input.organizationId
  )
    throw denied();
  const explicit = input.organization_id ?? input.organizationId;
  const selectors = (["import", "file", "review", "folder"] as const).flatMap((kind) =>
    typeof input[`${kind}_id`] === "string" ? [{ kind, id: input[`${kind}_id`] as string }] : [],
  );
  const parent = (kind: "import" | "file" | "review" | "folder") =>
    kind === "import"
      ? "designImport"
      : kind === "file"
        ? "designFile"
        : kind === "review"
          ? "githubReview"
          : "designFolder";
  return { explicit, selectors, parent };
}

/** Repeat parent bindings after quota admission, in the protected product scope. */
export async function retainMcpTargets(
  client: Pick<PoolClient, "query">,
  userId: string,
  organizationId: string,
  input: Record<string, unknown>,
) {
  const denied = () =>
    new McpUsageAccessError(
      "Workspace not found or access denied. Join or create a workspace in Tidy first.",
    );
  const { explicit, selectors, parent } = mcpTargets(input);
  if (explicit !== undefined && explicit !== organizationId) throw denied();
  const authority = await client.query(
    `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
       where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL} for share of m,u`,
    [organizationId, userId],
  );
  if (authority.rows.length !== 1) throw denied();
  // Every supplied selector must still belong to this workspace at reservation.
  for (const { kind, id } of selectors) {
    const result = await client.query<{ id: string; fileId?: string | null }>(
      kind === "review"
        ? `select r."id" from "githubReview" r join "designFile" f on f."id"=r."fileId" and f."organizationId"=r."organizationId"
             where r."id"=$1 and r."organizationId"=$2 and $3::text is not null for share of r,f`
        : kind === "import"
          ? `select i."id",i."fileId" from "designImport" i where i."id"=$1 and i."organizationId"=$2 and i."userId"=$3
               and (i."fileId" is null or exists(select 1 from "designFile" f where f."id"=i."fileId" and f."organizationId"=i."organizationId")) for share of i`
          : `select "id" from "${parent(kind)}" where "id"=$1 and "organizationId"=$2 and $3::text is not null for share`,
      [id, organizationId, userId],
    );
    if (result.rows.length !== 1) throw denied();
    if (kind === "import" && result.rows[0]!.fileId) {
      const file = await client.query(
        `select "id" from "designFile" where "id"=$1 and "organizationId"=$2 for share`,
        [result.rows[0]!.fileId, organizationId],
      );
      if (file.rows.length !== 1) throw denied();
    }
  }
}

function usageErrorMessage(error: unknown) {
  return (
    (error instanceof McpGrantError ? error.message : undefined) ??
    planLimitMessage(error) ??
    (error instanceof McpUsageAccessError || (error as { code?: string })?.code === "42501"
      ? "Workspace not found or access denied. Join or create a workspace in Tidy first."
      : "Could not verify MCP usage. Try again.")
  );
}

/** Only external MCP tools and resource reads are metered; internal agent tools and protocol
 * discovery/initialization do not use this wrapper. Reserve before execution. */
type Handler = (...args: unknown[]) => Promise<unknown>;
type Execute = (
  organizationId: string | void,
  input: Record<string, unknown>,
  work: () => Promise<unknown>,
) => Promise<unknown>;
export function meterMcpServer(
  server: McpServer,
  userId: string,
  consume: (
    userId: string,
    input: Record<string, unknown>,
  ) => Promise<string | void> = consumeMcpCall,
  execute: Execute = (_organizationId, _input, work) => work(),
) {
  type Register = (name: string, config: unknown, callback: Handler) => unknown;
  const register = server.registerTool.bind(server) as Register;
  server.registerTool = ((name: string, config: unknown, callback: Handler) =>
    register(name, config, async (...args) => {
      const input = record(args[0]);
      let organizationId: string | void;
      try {
        organizationId = await consume(userId, input);
      } catch (error) {
        return { content: [{ type: "text", text: usageErrorMessage(error) }], isError: true };
      }
      try {
        return await execute(organizationId, input, () => callback(...args));
      } catch (error) {
        if (!(error instanceof PublicActionError)) throw error;
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    })) as McpServer["registerTool"];
  // Meter the file resource too, so resources/read cannot bypass get_file's cap.
  // Template variables contain file_id; static resources use the default workspace.
  type RegisterResource = (
    name: string,
    uri: unknown,
    config: unknown,
    callback: Handler,
  ) => unknown;
  const registerResource = server.registerResource.bind(server) as RegisterResource;
  server.registerResource = ((name: string, uri: unknown, config: unknown, callback: Handler) =>
    registerResource(name, uri, config, async (...args) => {
      const input = record(args[1]);
      let organizationId: string | void;
      try {
        organizationId = await consume(userId, input);
      } catch (error) {
        throw new Error(usageErrorMessage(error));
      }
      return execute(organizationId, input, () => callback(...args));
    })) as McpServer["registerResource"];
  return server;
}
