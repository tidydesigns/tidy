import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { validSignature } from "@/lib/connectors/crypto";
import { ConnectorError } from "@/lib/connectors/http";
import { requireConnectorSchema } from "@/lib/connectors/store";
import { linearConfig } from "./config";

export async function linearWebhook(
  body: string,
  signature: string | null,
  delivery: string | null,
) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) throw new ConnectorError("Linear webhook is not configured.", 503);
  if (!validSignature(body, signature, secret)) throw new ConnectorError("Invalid signature.", 401);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ConnectorError("Invalid webhook JSON.");
  }
  const payload = z
    .object({
      type: z.string(),
      action: z.string(),
      organizationId: z.string().uuid(),
      oauthClientId: z.string().optional(),
      webhookTimestamp: z.number(),
    })
    .parse(parsed);
  if (Math.abs(Date.now() - payload.webhookTimestamp) > 60000)
    throw new ConnectorError("Expired webhook.", 401);
  const id = z.string().uuid().parse(delivery);
  await requireConnectorSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into "connectorWebhookDelivery" ("provider","id") values ('linear',$1) on conflict do nothing returning "id"`,
      [id],
    );
    if (
      inserted.rowCount &&
      payload.type === "OAuthApp" &&
      payload.action === "revoked" &&
      payload.oauthClientId === linearConfig().clientId
    ) {
      await client.query(
        `update "connectorAccount" set "credentials"=null,"state"='reconnect',"updatedAt"=now() where "provider"='linear' and "externalWorkspaceId"=$1`,
        [payload.organizationId],
      );
    }
    // Issue and comment data are always fetched with the requesting user's token.
    // Never fan webhook content out to other Tidy members or overwrite local feedback.
    await client.query(
      `delete from "connectorWebhookDelivery" where "createdAt"<now()-interval '30 days'`,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
