import { z } from "zod";

export const threadRecoveryRequestSchema = z
  .object({
    projectId: z.uuid(),
    /** Omit to discover limited threads on the host without loading design metadata. */
    threads: z
      .array(z.object({ threadId: z.uuid(), revision: z.number().int().nonnegative() }).strict())
      .max(1000)
      .optional(),
  })
  .strict();

export const threadRecoveryResultSchema = z.object({
  resumed: z.array(z.uuid()),
  skipped: z.array(z.uuid()),
  failed: z.array(z.object({ threadId: z.uuid(), error: z.string().max(4000) })),
});

export type ThreadRecoveryRequest = z.infer<typeof threadRecoveryRequestSchema>;
export type ThreadRecoveryResult = z.infer<typeof threadRecoveryResultSchema>;

/** Minimal host state for recovery discovery; never includes messages or provider sessions. */
export const threadRecoveryStateSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  limited: z.boolean(),
});
export type ThreadRecoveryState = z.infer<typeof threadRecoveryStateSchema>;
