import { z } from "zod";

export const ANALYTICS_NOTICE = "2026-10-26.desktop-analytics-1";
export const ANALYTICS_DAYS = 90;
export const analyticsChoicesSchema = z
  .object({
    usage: z.boolean(),
    diagnostics: z.boolean(),
  })
  .strict();
export type AnalyticsChoices = z.infer<typeof analyticsChoicesSchema>;
export const essentialAnalytics: AnalyticsChoices = { usage: false, diagnostics: false };
const release = z
  .string()
  .max(60)
  .regex(/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
const harness = z.enum(["codex", "claude", "opencode", "other", "unknown"]);
const result = z.enum(["success", "failed", "cancelled"]);
export const analyticsEventSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("desktop_first_seen") }).strict(),
  z.object({ name: z.literal("product_active_day") }).strict(),
  z.object({ name: z.literal("harness_turn_started"), harness }).strict(),
  z.object({ name: z.literal("harness_turn_finished"), harness, result }).strict(),
  z
    .object({
      name: z.literal("design_file_created"),
      storage: z.enum(["local", "cloud"]),
      kind: z.enum(["new", "import", "copy"]),
    })
    .strict(),
  z.object({ name: z.literal("design_cloud_connected") }).strict(),
  z
    .object({
      name: z.literal("desktop_update_result"),
      stage: z.enum(["download", "install"]),
      result,
      from: release,
      to: release,
    })
    .strict(),
  z.object({ name: z.literal("desktop_harness_update_result"), harness, result }).strict(),
  z
    .object({
      name: z.literal("desktop_sync_result"),
      result: z.enum(["success", "failed", "conflict"]),
    })
    .strict(),
  z
    .object({
      name: z.literal("desktop_error"),
      operation: z.enum(["renderer", "harness", "sync", "storage", "startup", "update"]),
      category: z.enum(["unavailable", "timeout", "invalid", "unexpected"]),
    })
    .strict(),
  z
    .object({
      name: z.literal("desktop_performance"),
      operation: z.enum(["startup", "interaction"]),
      duration: z.enum(["under_100ms", "under_1s", "under_5s", "over_5s"]),
    })
    .strict(),
]);
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
export function analyticsPurpose(event: AnalyticsEvent): keyof AnalyticsChoices {
  return [
    "desktop_update_result",
    "desktop_harness_update_result",
    "desktop_sync_result",
    "desktop_error",
    "desktop_performance",
  ].includes(event.name)
    ? "diagnostics"
    : "usage";
}
export const analyticsEnvelopeSchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    release,
    platform: z.enum(["darwin", "win32", "linux"]),
    arch: z.enum(["arm64", "x64", "other"]),
    event: analyticsEventSchema,
  })
  .strict();
export type AnalyticsEnvelope = z.infer<typeof analyticsEnvelopeSchema>;
export const analyticsReceiptSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    linked: z.boolean(),
  })
  .strict();
export type AnalyticsReceipt = z.infer<typeof analyticsReceiptSchema>;
export const analyticsStateSchema = analyticsChoicesSchema
  .extend({
    notice: z.literal(ANALYTICS_NOTICE),
    available: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
    linked: z.boolean(),
    pendingDeletion: z.boolean(),
  })
  .strict();
export type AnalyticsState = z.infer<typeof analyticsStateSchema>;
export type AnalyticsAPI = {
  subscribe(listener: (state: AnalyticsState) => void): () => void;
  reportError(): Promise<void>;
  performance(duration: "under_100ms" | "under_1s" | "under_5s" | "over_5s"): Promise<void>;
  state(): Promise<AnalyticsState>;
  choose(choices: AnalyticsChoices): Promise<AnalyticsState>;
  link(): Promise<void>;
  unlink(): Promise<AnalyticsState>;
  erase(): Promise<AnalyticsState>;
  reports(): Promise<string>;
  policy(): Promise<void>;
};
