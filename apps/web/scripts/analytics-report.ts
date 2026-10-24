import { Pool } from "pg";
import {
  activityReport,
  retentionReport,
  linkedReport,
  versionsReport,
  diagnosticsReport,
  downloadReport,
  downloadDeltaReport,
  accountRetentionReport,
  weeklyRetentionReport,
} from "../lib/analytics/reports";
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL explicitly to the intended database.");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
});
const client = await pool.connect();
try {
  await client.query("begin read only");
  await client.query("set local statement_timeout='10s'");
  const result: Record<string, unknown> = {};
  for (const [name, query] of Object.entries({
    activity: activityReport,
    retention: retentionReport,
    linkedAccounts: linkedReport,
    versions: versionsReport,
    diagnostics: diagnosticsReport,
    downloads: downloadReport,
    downloadDeltas: downloadDeltaReport,
    linkedAccountRetention: accountRetentionReport,
    weeklyRetention: weeklyRetentionReport,
  }))
    result[name] = (await client.query(query)).rows;
  await client.query("commit");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  client.release();
  await pool.end();
}
