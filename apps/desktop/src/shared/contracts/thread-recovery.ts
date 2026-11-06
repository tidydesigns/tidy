import { z } from "zod";

export const threadRecoveryRequestSchema = z
  .object({
    projectId: z.uuid(),
    threads: z
      .array(z.object({ threadId: z.uuid(), revision: z.number().int().nonnegative() }).strict())
      .max(1000),
  })
  .strict();

export const threadRecoveryResultSchema = z.object({
  resumed: z.array(z.uuid()),
  skipped: z.array(z.uuid()),
  failed: z.array(z.object({ threadId: z.uuid(), error: z.string().max(4000) })),
});

export type ThreadRecoveryRequest = z.infer<typeof threadRecoveryRequestSchema>;
export type ThreadRecoveryResult = z.infer<typeof threadRecoveryResultSchema>;
