import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const tables = [
  "jwks",
  "oauthClient",
  "oauthResource",
  "oauthClientResource",
  "oauthRefreshToken",
  "oauthAccessToken",
  "oauthConsent",
  "oauthClientAssertion",
];
const sql = await readFile(
  fileURLToPath(new URL("../../../migrations/schema-mcp.sql", import.meta.url)),
  "utf8",
);
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const existing = await client.query(
    "select name, to_regclass(quote_ident(name)) is not null as present from unnest($1::text[]) as name",
    [tables],
  );
  if (process.argv.includes("--check")) {
    console.log(existing.rows);
    process.exitCode = existing.rows.some((row) => row.present) ? 1 : 0;
  } else {
    if (existing.rows.some((row) => row.present))
      throw new Error(
        "At least one MCP auth table already exists. Review the schema before retrying.",
      );
    await client.query("begin");
    try {
      await client.query(sql);
      const verified = await client.query(
        "select name, to_regclass(quote_ident(name)) is not null as present from unnest($1::text[]) as name",
        [tables],
      );
      if (verified.rows.some((row) => !row.present))
        throw new Error("A required MCP auth table is missing.");
      await client.query("commit");
      console.log(`Created and verified ${verified.rows.length} MCP auth tables.`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
