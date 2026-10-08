import type { Client } from "pg";

/** Operator-only maintenance. Static identifiers; no caller-selected tables. */
export const EXPIRY_RETENTION = [
  { table: "verification", days: 1 },
  { table: "session", days: 1 },
  { table: "oauthAccessToken", days: 1 },
  { table: "oauthRefreshToken", days: 7 },
  { table: "oauthClientAssertion", days: 1 },
  { table: "designImport", days: 7 },
] as const;

export async function maintainExpiredState(
  client: Pick<Client, "query">,
  apply = false,
  batchSize = 1000,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Cleanup batch must be between 1 and 1000.");
  const report: { table: string; eligible: number; removed: number }[] = [];
  for (const { table, days } of EXPIRY_RETENTION) {
    await client.query(apply ? "begin" : "begin read only");
    try {
      await client.query("set local statement_timeout='10s'");
      await client.query("set local lock_timeout='2s'");
      const eligible = Number(
        (
          await client.query<{ count: string }>(
            `select count(*) from "${table}" where "expiresAt" < now()-$1*interval '1 day'`,
            [days],
          )
        ).rows[0].count,
      );
      let removed = 0;
      if (apply) {
        const result = await client.query(
          `with expired as (
          select "id" from "${table}" where "expiresAt" < now()-$1*interval '1 day'
          order by "expiresAt","id" limit $2 for update skip locked
        ) delete from "${table}" row using expired where row."id"=expired."id"`,
          [days, batchSize],
        );
        removed = result.rowCount ?? 0;
      }
      await client.query("commit");
      report.push({ table, eligible, removed });
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  return report;
}
