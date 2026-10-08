import "server-only";
import { db } from "@/lib/db";
import { can } from "@/lib/organizations/roles";
import type { PlanLimits, PlanUsage } from "./plans";

// Pricing is operator-owned. Application traffic can verify it but cannot enroll
// arbitrary prices or change plan limits, even when runtime configuration drifts.
export async function requireRegisteredProPrice() {
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) throw new Error("Pro pricing is not configured.");
  const result = await db.query('select "priceId" from "billingPlanPrice" where "priceId"=$1', [
    priceId,
  ]);
  if (!result.rowCount)
    throw new Error("The configured Pro price has not been registered by an operator.");
}

export async function organizationPlanUsage(organizationId: string) {
  const result = await db.query<{ plan: PlanUsage }>('select "organizationPlanUsage"($1) as plan', [
    organizationId,
  ]);
  if (!result.rows[0]?.plan) throw new Error("Plan allowances are not configured.");
  return result.rows[0].plan;
}

export async function organizationPlanTier(organizationId: string): Promise<PlanUsage["tier"]> {
  const result = await db.query<{ tier: PlanUsage["tier"] | null }>(
    'select "organizationPlan"($1) as tier',
    [organizationId],
  );
  if (!result.rows[0]?.tier) throw new Error("Plan allowances are not configured.");
  return result.rows[0].tier;
}

export async function proPlanLimits(): Promise<PlanLimits> {
  const result = await db.query<PlanLimits>(
    'select "fileLimit" as files, "editorLimit" as editors, "storageLimit"::float8 as "storageBytes", "mcpCallLimit"::float8 as "mcpCalls" from "billingPlan" where "id" = \'pro\'',
  );
  if (!result.rows[0]) throw new Error("Pro allowances are not configured.");
  return result.rows[0];
}

// Friendly preflight for Better Auth. Database triggers remain authoritative
// when two requests contend for the last seat.
export async function checkInvitationPlan(organizationId: string, email: string, role: string) {
  if (!can(role, "edit")) return;
  await db.query('select "checkEditorCapacity"($1, $2)', [organizationId, email]);
}
