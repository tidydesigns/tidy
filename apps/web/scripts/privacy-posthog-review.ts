import { Client } from "pg";
import { completePostHogReview } from "../lib/privacy/cleanup-operations";

// No implicit DATABASE_URL or production target. Supply an operator-scoped URL privately.
const url = process.env.PRIVACY_OPERATIONS_DATABASE_URL;
const args = process.argv.slice(2);
const list = args.length === 1 && args[0] === "list";
const complete = args.length === 4 && args[0] === "complete" && args[3] === "--verified";
if (!url || (!list && !complete))
  throw new Error(
    "Set PRIVACY_OPERATIONS_DATABASE_URL explicitly. Usage: bun apps/web/scripts/privacy-posthog-review.ts list | complete <job-uuid> <private-evidence-reference> --verified",
  );
const client = new Client({ connectionString: url });
try {
  await client.connect();
  if (list) {
    // Contains identifiers: keep output private. The operator must inspect both queues.
    const rows = (
      await client.query(
        `select id,kind,subject,"createdAt",attempts,"nextAttemptAt" from "privacyCleanup" where kind in ('posthog','posthog-review') order by "createdAt" limit 100`,
      )
    ).rows;
    console.log(JSON.stringify(rows, null, 2));
  } else {
    await completePostHogReview(client, args[1], args[2]);
    console.log("Recorded verified completion and removed the pending job.");
  }
} finally {
  await client.end();
}
