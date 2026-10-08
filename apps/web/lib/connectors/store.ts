import {
  OrganizationAccessError,
  requireOrganizationPermission,
} from "@/lib/organizations/authorization";
import "server-only";
import { db } from "@/lib/db";
import { requestWork } from "@/lib/request-work";
import { type Permission } from "@/lib/organizations/roles";
import { ConnectorError } from "./http";

export async function connectorSchemaReady() {
  return requestWork("connectorSchemaReady", async () => {
    const result = await db.query<{
      ready: boolean;
    }>(`select to_regclass('public."connectorAccount"') is not null
      and to_regclass('public."connectorConnection"') is not null and to_regclass('public."connectorOAuthState"') is not null
      and to_regclass('public."connectorOperation"') is not null and to_regclass('public."connectorWebhookDelivery"') is not null as ready`);
    return result.rows[0]?.ready === true;
  });
}
export async function requireConnectorSchema() {
  if (!(await connectorSchemaReady()))
    throw new ConnectorError("Connectors are not available yet.", 503);
}
export async function connectorPermission(
  userId: string,
  organizationId: string,
  permission: Permission = "view",
) {
  try {
    await requireOrganizationPermission(userId, organizationId, permission);
  } catch (error) {
    if (error instanceof OrganizationAccessError)
      throw new ConnectorError("Workspace access denied.", 403);
    throw error;
  }
}
