import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000);
export const resetCreditSchema = z.object({
  id: z.string().min(1).max(1024),
  resetType: z.string().max(100),
  status: z.string().max(100),
  grantedAt: timestamp,
  expiresAt: timestamp.nullable(),
  title: z.string().max(2000).nullable(),
  description: z.string().max(4000).nullable(),
});
export const resetSelectionSchema = z
  .object({
    accountKey: z.string().regex(/^[a-f0-9]{64}$/),
    creditId: z.string().min(1).max(1024),
    expiresAt: timestamp.nullable(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const resetOutcomeSchema = z.enum([
  "reset",
  "alreadyRedeemed",
  "nothingToReset",
  "noCredit",
]);
export const codexUsageSchema = z.object({
  accountKey: resetSelectionSchema.shape.accountKey.nullable(),
  checkedAt: z.iso.datetime(),
  windows: z.array(
    z.object({
      name: z.string(),
      usedPercent: z.number().min(0).max(100),
      resetsAt: timestamp.nullable(),
    }),
  ),
  resets: z
    .object({
      availableCount: z.number().int().nonnegative().safe(),
      credits: z.array(resetCreditSchema).nullable(),
    })
    .nullable(),
  redemptionUnavailable: z.string().nullable(),
  resetDetailsError: z.string().nullable().optional(),
  pendingReset: resetSelectionSchema.nullable(),
});
export const resetResultSchema = z.object({
  outcome: z.union([resetOutcomeSchema, z.literal("unconfirmed")]),
  usage: codexUsageSchema.nullable(),
});
export type CodexUsage = z.infer<typeof codexUsageSchema>;
export type ResetCredit = z.infer<typeof resetCreditSchema>;
export type ResetSelection = z.infer<typeof resetSelectionSchema>;
export type ResetResult = z.infer<typeof resetResultSchema>;

/** Provider IDs are opaque. Never use array position, grant order or display text as identity. */
export function availableResetCredits(usage: CodexUsage, now = Date.now()): ResetCredit[] {
  return (usage.resets?.credits ?? [])
    .filter(
      (credit) =>
        credit.status === "available" &&
        credit.resetType === "codexRateLimits" &&
        (credit.expiresAt === null || credit.expiresAt * 1000 > now),
    )
    .sort(
      (a, b) =>
        (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
        a.grantedAt - b.grantedAt ||
        a.id.localeCompare(b.id),
    );
}
