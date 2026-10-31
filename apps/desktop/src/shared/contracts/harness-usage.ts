import { z } from "zod";

/** Account allowances are separate from conversation tokens and estimated model costs. */
export const usageWindowSchema = z.object({
  id: z.string().max(300),
  name: z.string().max(200),
  bucket: z.string().max(200).optional(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().finite().nonnegative().max(8_640_000_000_000).optional(),
  windowMinutes: z.number().positive().optional(),
  limited: z.boolean().optional(),
  spentUSD: z.number().nonnegative().optional(),
  limitUSD: z.number().nonnegative().optional(),
});
export const harnessUsageSchema = z.object({
  account: z
    .object({
      plan: z.string().max(200).optional(),
      workspace: z.string().max(200).optional(),
      billing: z.enum(["subscription", "api", "unknown"]),
    })
    .optional(),
  windows: z.array(usageWindowSchema).max(100),
  credits: z
    .object({
      balance: z.string().max(100).optional(),
      unlimited: z.boolean(),
      hasCredits: z.boolean(),
    })
    .optional(),
  resets: z
    .object({
      availableCount: z.number().int().nonnegative(),
      items: z
        .array(
          z.object({
            id: z.string().max(300),
            title: z.string().max(200).optional(),
            expiresAt: z
              .number()
              .finite()
              .nonnegative()
              .max(8_640_000_000_000)
              .nullable()
              .optional(),
          }),
        )
        .max(100)
        .optional(),
    })
    .optional(),
  state: z.enum(["available", "warning", "limited", "unknown"]),
  note: z.string().max(500).optional(),
  updatedAt: z.iso.datetime(),
  usagePage: z.enum(["subscription", "api"]),
});
export type HarnessUsage = z.infer<typeof harnessUsageSchema>;
export type AccountUsageWindow = z.infer<typeof usageWindowSchema>;
