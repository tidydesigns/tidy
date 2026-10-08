import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { organizationNameSchema } from "./name";

export class OrganizationCreationError extends Error {}

export async function organizationCreationStatus(userId: string) {
  try {
    const result = await db.query<{ allowed: boolean }>(
      'select "canCreateOrganization"($1) as allowed',
      [userId],
    );
    return { ready: true, canCreateOrganization: result.rows[0]?.allowed === true };
  } catch (error) {
    if (["42P01", "42883", "42703"].includes((error as { code?: string }).code ?? ""))
      return { ready: false, canCreateOrganization: false };
    throw error;
  }
}

function creationLimitMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: string; detail?: string };
  if (value.code !== "P0001" || !value.detail) return null;
  try {
    return JSON.parse(value.detail).code === "ORGANIZATION_CREATION_LIMIT"
      ? "You can create one organization. You can still join other organizations by invitation."
      : null;
  } catch {
    return null;
  }
}

// The actor and optional session ID come from server authentication, never a
// client payload. Organization, owner membership and active session are atomic.
export async function createOrganizationForUser(userId: string, name: string, sessionId?: string) {
  const parsed = organizationNameSchema.safeParse(name);
  if (!parsed.success) throw new OrganizationCreationError(parsed.error.issues[0].message);
  const id = randomUUID();
  const base = parsed.data
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/^-|-$/g, "");
  const slug = `${base || "organisation"}-${id}`;
  const connection = await db.connect();
  try {
    await connection.query("begin");
    const organization = (
      await connection.query<{ id: string; name: string; slug: string }>(
        `insert into "organization"
      ("id", "name", "slug", "createdAt", "createdByUserId") values ($1,$2,$3,now(),$4) returning "id","name","slug"`,
        [id, parsed.data, slug, userId],
      )
    ).rows[0];
    await connection.query(
      `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',now())`,
      [randomUUID(), id, userId],
    );
    if (sessionId) {
      const updated = await connection.query(
        'update "session" set "activeOrganizationId"=$1 where "id"=$2 and "userId"=$3',
        [id, sessionId, userId],
      );
      if (!updated.rowCount)
        throw new OrganizationCreationError(
          "Your session has ended. Sign in again to create an organization.",
        );
    }
    await connection.query("commit");
    return organization;
  } catch (error) {
    await connection.query("rollback");
    const message = creationLimitMessage(error);
    if (message) throw new OrganizationCreationError(message);
    if (["42P01", "42883", "42703"].includes((error as { code?: string }).code ?? ""))
      throw new OrganizationCreationError("Organization creation is temporarily unavailable.");
    throw error;
  } finally {
    connection.release();
  }
}
