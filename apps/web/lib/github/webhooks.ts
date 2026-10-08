import * as z from "zod";
import { db } from "@/lib/db";
import { githubRequest, installationToken } from "./client";
import { githubSchemaReady } from "./connections";
import type { Pull } from "./reviews";
import { checkedPull } from "./validation";

const payloadSchema = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({ id: z.number().int().positive() }).optional(),
  sender: z.object({ id: z.number().int().positive() }).optional(),
});
export async function processWebhook(deliveryId: string, event: string, input: unknown) {
  if (!(await githubSchemaReady())) throw new Error("GitHub migration is not applied.");
  const payload = payloadSchema.parse(input);
  const client = await db.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into "githubWebhookDelivery" ("id") values ($1) on conflict do nothing returning "id"`,
      [deliveryId],
    );
    if (!inserted.rowCount) {
      await client.query("commit");
      return;
    }
    if (event === "github_app_authorization" && payload.action === "revoked" && payload.sender) {
      await client.query(`delete from "githubUser" where "githubId"=$1`, [payload.sender.id]);
    } else if (event === "installation" && payload.installation) {
      if (["deleted", "suspend", "unsuspend"].includes(payload.action ?? "")) {
        await client.query(`update "githubConnection" set "active"=$2 where "installationId"=$1`, [
          payload.installation.id,
          payload.action === "unsuspend",
        ]);
      }
    } else if (event === "pull_request" && payload.repository && payload.installation) {
      const rows = await client.query<{ id: string; repository: string; number: number }>(
        `select r."id",r."repository",r."number" from "githubReview" r join "githubConnection" c on c."organizationId"=r."organizationId" and c."installationId"=r."installationId" where r."repositoryId"=$1 and r."installationId"=$2 and c."active"=true order by r."id"`,
        [payload.repository.id, payload.installation.id],
      );
      if (rows.rowCount) {
        const token = await installationToken(String(payload.installation.id));
        for (const row of rows.rows) {
          await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [row.id]);
          const pull = checkedPull(
            await githubRequest<Pull>(token, `/repos/${row.repository}/pulls/${row.number}`),
          );
          if (pull.base.repo.id !== payload.repository.id)
            throw new Error("Webhook repository mismatch.");
          await client.query(
            `update "githubReview" set "repository"=$2,"title"=$3,"url"=$4,"state"=$5,"branch"=$6,"baseSha"=$7,"headSha"=$8 where "id"=$1`,
            [
              row.id,
              pull.base.repo.full_name,
              pull.title,
              pull.html_url,
              pull.merged ? "merged" : pull.state,
              pull.head.ref,
              pull.base.sha,
              pull.head.sha,
            ],
          );
        }
      }
    }
    // Checks, deployment statuses and comments are fetched from GitHub when the review is read.
    // No event payload can replace a newer canonical PR head or a pinned snapshot.
    await client.query(
      `delete from "githubWebhookDelivery" where "createdAt" < now() - interval '30 days'`,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
