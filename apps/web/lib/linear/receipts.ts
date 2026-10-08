import "server-only";
import { db } from "@/lib/db";
import { withoutDatabaseScope } from "@/lib/database-scope";
import { ConnectorError } from "@/lib/connectors/error";
import { hash } from "@/lib/connectors/crypto";
import { LINEAR_LIMITS } from "@/lib/security/resource-limits";
import { checkLinearAuthority, type LinearAuthority } from "./authority";

type Result = { id: string };
type Reservation = { fresh: true } | { fresh: false; result: Result };

/** These commits survive a later product-tool rollback. The receipt lock is
 * separate from the enclosing product transaction's workspace lock. */
export function reserveLinearReceipt(
  userId: string,
  access: LinearAuthority,
  operationId: string,
  kind: string,
  payload: unknown,
): Promise<Reservation> {
  return withoutDatabaseScope(async () => {
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `linear-receipts:${access.organizationId}`,
      ]);
      await checkLinearAuthority(client, userId, access, true);
      const digest = hash(JSON.stringify(payload));
      const previous = (
        await client.query<{
          connectionId: string;
          kind: string;
          inputHash: string;
          state: string;
          result: Result | null;
        }>(
          `select "connectionId","kind","inputHash","state","result" from "connectorOperation" where "id"=$1`,
          [operationId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.connectionId !== access.connectionId ||
          previous.kind !== kind ||
          previous.inputHash !== digest
        )
          throw new ConnectorError(
            "This operation ID was already used for a different request.",
            409,
          );
        if (previous.state !== "succeeded" || !previous.result?.id)
          throw new ConnectorError(
            "This operation may already have reached Linear. Check Linear before starting another operation.",
            409,
          );
        await client.query("commit");
        return { fresh: false, result: { id: previous.result.id } };
      }
      const capacity = (
        await client.query<{ workspace: number; connection: number }>(
          `select count(*)::int as workspace, count(*) filter(where o."connectionId"=$2)::int as connection
         from "connectorOperation" o join "connectorConnection" c on c."id"=o."connectionId" where c."organizationId"=$1`,
          [access.organizationId, access.connectionId],
        )
      ).rows[0]!;
      if (
        capacity.workspace >= LINEAR_LIMITS.operationsPerOrganization ||
        capacity.connection >= LINEAR_LIMITS.operationsPerConnection
      )
        throw new ConnectorError(
          "Linear operation history is full. Contact support before starting another operation.",
          409,
        );
      // A conflicting ID in another workspace cannot be allowed to replace a receipt.
      const inserted = await client.query(
        `insert into "connectorOperation" ("id","connectionId","kind","inputHash","state") values ($1,$2,$3,$4,'pending') on conflict do nothing returning "id"`,
        [operationId, access.connectionId, kind, digest],
      );
      if (inserted.rowCount !== 1)
        throw new ConnectorError(
          "This operation ID was already used for a different request.",
          409,
        );
      await client.query("commit");
      return { fresh: true };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export function finishLinearReceipt(connectionId: string, operationId: string, result?: Result) {
  return withoutDatabaseScope(async () => {
    const updated = await db.query(
      `update "connectorOperation" set "state"=$3,"result"=$4,"updatedAt"=now()
       where "id"=$1 and "connectionId"=$2 and "state"='pending' returning "id"`,
      [operationId, connectionId, result ? "succeeded" : "uncertain", result ?? null],
    );
    if (updated.rowCount !== 1)
      throw new ConnectorError(
        "Linear operation status could not be confirmed. Check Linear before trying again.",
        409,
      );
  });
}
