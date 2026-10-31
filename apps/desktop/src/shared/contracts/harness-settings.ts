import { harnessUsageSchema } from "./harness-usage";
import { z } from "zod";
import { permissionModeSchema } from "./permissions";
export const harnessSettingsSchema = z
  .object({
    permissionMode: permissionModeSchema.optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^-\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/)
      .optional(),
    effort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,29}$/)
      .optional(),
  })
  .strict();
export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  costUSD: z.number().nonnegative().optional(),
});
export type HarnessSettings = z.infer<typeof harnessSettingsSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export const harnessDetailsSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      efforts: z.array(z.string()),
      defaultEffort: z.string().optional(),
    }),
  ),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  windows: z.array(
    z.object({
      name: z.string(),
      usedPercent: z.number(),
      resetsAt: z.number().optional(),
      windowMinutes: z.number().optional(),
    }),
  ),
  usage: harnessUsageSchema.optional(),
  usageError: z.string().optional(),
  updatedAt: z.string(),
  usagePage: z.enum(["subscription", "api"]),
});
export type HarnessDetails = z.infer<typeof harnessDetailsSchema>;
export type HarnessModel = HarnessDetails["models"][number];
export type UsageWindow = HarnessDetails["windows"][number];
