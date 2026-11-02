import { z } from "zod";

export const mobilePlatformSchema = z.enum(["ios", "android"]);
export const mobileDeviceSchema = z.object({
  id: z.string().min(1).max(200),
  platform: mobilePlatformSchema,
  name: z.string().max(200),
  runtime: z.string().max(200),
  state: z.enum(["running", "stopped", "starting", "offline"]),
});
export const mobileTargetSchema = z.object({
  id: z.string().max(500),
  name: z.string().max(200),
  directory: z.string().max(4096),
  kind: z.enum(["expo", "react-native", "flutter", "xcode", "gradle"]),
  platforms: z.array(mobilePlatformSchema),
  scheme: z.string().max(200).optional(),
});
export const mobileSessionSchema = z.object({
  id: z.uuid(),
  deviceId: z.string().max(200),
  phase: z.enum(["starting", "ready", "error"]),
  message: z.string().max(1000),
  run: z
    .object({
      id: z.uuid(),
      targetId: z.string().max(500),
      phase: z.enum(["building", "running", "stopped", "failed"]),
      message: z.string().max(1000),
      output: z.string().max(64_000),
    })
    .optional(),
});
export const mobileStateSchema = z.object({
  devices: z.array(mobileDeviceSchema).max(200),
  targets: z.array(mobileTargetSchema).max(100),
  requirements: z
    .array(
      z.object({
        platform: mobilePlatformSchema,
        ready: z.boolean(),
        message: z.string().max(1000),
        helpURL: z.string().url(),
      }),
    )
    .max(2),
  session: mobileSessionSchema.nullable(),
});
export const mobileScopeSchema = z.object({ projectId: z.uuid() }).strict();
export const mobileBuildScopeSchema = mobileScopeSchema
  .extend({
    threadId: z.uuid().optional(),
    threadProjectId: z.uuid().optional(),
  })
  .strict();
export const mobileSessionRequestSchema = mobileScopeSchema
  .extend({ sessionId: z.uuid() })
  .strict();
const mobileBuildSessionRequestSchema = mobileBuildScopeSchema
  .extend({ sessionId: z.uuid() })
  .strict();
export const mobileCommandSchema = z.discriminatedUnion("kind", [
  mobileBuildScopeSchema
    .extend({ kind: z.literal("connect"), deviceId: z.string().min(1).max(200) })
    .strict(),
  mobileBuildSessionRequestSchema.extend({ kind: z.literal("disconnect") }).strict(),
  mobileBuildSessionRequestSchema
    .extend({
      kind: z.literal("run"),
      targetId: z.string().min(1).max(500),
    })
    .strict(),
  mobileBuildSessionRequestSchema.extend({ kind: z.literal("stop") }).strict(),
  mobileBuildSessionRequestSchema.extend({ kind: z.literal("reload") }).strict(),
  mobileBuildSessionRequestSchema.extend({ kind: z.literal("home") }).strict(),
  mobileBuildSessionRequestSchema.extend({ kind: z.literal("back") }).strict(),
  mobileBuildSessionRequestSchema.extend({ kind: z.literal("rotate") }).strict(),
]);
export const mobileStateRequestSchema = mobileBuildScopeSchema
  .extend({ refresh: z.boolean().optional() })
  .strict();
export const mobileFrameRequestSchema = mobileSessionRequestSchema
  .extend({ after: z.number().int().nonnegative() })
  .strict();
export const mobileFrameSchema = z.object({
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  sequence: z.number().int().nonnegative(),
  mime: z.enum(["image/jpeg", "image/png"]),
  data: z.string().max(2_800_000),
  width: z.number().int().positive().max(10000),
  height: z.number().int().positive().max(10000),
});
const coordinate = z.number().finite().min(0).max(1);
export const mobileInputSchema = mobileSessionRequestSchema
  .extend({
    event: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("touch"),
          phase: z.enum(["down", "move", "up"]),
          x: coordinate,
          y: coordinate,
        })
        .strict(),
      z
        .object({
          kind: z.literal("key"),
          code: z.string().min(1).max(40),
          shift: z.boolean().optional(),
        })
        .strict(),
      z.object({ kind: z.literal("text"), text: z.string().min(1).max(4096) }).strict(),
    ]),
  })
  .strict();

export type MobileBuildScope = z.infer<typeof mobileBuildScopeSchema>;
export type MobilePlatform = z.infer<typeof mobilePlatformSchema>;
export type MobileDevice = z.infer<typeof mobileDeviceSchema>;
export type MobileTarget = z.infer<typeof mobileTargetSchema>;
export type MobileState = z.infer<typeof mobileStateSchema>;
export type MobileSession = z.infer<typeof mobileSessionSchema>;
export type MobileCommand = z.infer<typeof mobileCommandSchema>;
export type MobileFrame = z.infer<typeof mobileFrameSchema>;
export type MobileInput = z.infer<typeof mobileInputSchema>;
export type MobileAPI = {
  state(input: z.infer<typeof mobileStateRequestSchema>): Promise<MobileState>;
  command(input: MobileCommand): Promise<MobileState>;
  frame(input: z.infer<typeof mobileFrameRequestSchema>): Promise<MobileFrame | null>;
  input(input: MobileInput): Promise<void>;
};
