// Report by default; production application requires an approved explicit target.
import { Client } from "pg";
import { maintainExpiredState } from "../lib/security/expired-state";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply" && !arg.startsWith("--target=")))
  throw new Error(
    "Use --apply and --target=host:port/database, or no arguments for a read-only report.",
  );
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
const database = new URL(connectionString);
const target = `${database.hostname}:${database.port || "5432"}${database.pathname}`;
const apply = args.includes("--apply");
if (apply && args.find((arg) => arg.startsWith("--target=")) !== `--target=${target}`)
  throw new Error(`Confirm --target=${target}.`);
const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
await client.connect();
try {
  console.log(JSON.stringify({ target, apply, tables: await maintainExpiredState(client, apply) }));
} finally {
  await client.end();
}
