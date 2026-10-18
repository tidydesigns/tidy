import { z } from "zod";
import { permissionModeSchema } from "./permissions";
export const harnessSettingsSchema = z
  .object({
    permissionMode: permissionModeSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
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
export type HarnessModel = {
  id: string;
  name: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
};
export type UsageWindow = {
  name: string;
  usedPercent: number;
  resetsAt?: number;
  windowMinutes?: number;
};
export type HarnessDetails = {
  models: HarnessModel[];
  defaultModel?: string;
  defaultEffort?: string;
  windows: UsageWindow[];
  usageError?: string;
  updatedAt: string;
  usagePage: "subscription" | "api";
};
