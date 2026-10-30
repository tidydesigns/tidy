import { z } from "zod";

export const terminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
});
export const terminalScopeSchema = terminalSizeSchema
  .extend({
    projectId: z.uuid(),
    resume: z
      .object({ sessionId: z.uuid(), sequence: z.number().int().nonnegative().safe() })
      .optional(),
  })
  .strict();
export type TerminalScope = z.infer<typeof terminalScopeSchema>;
export const terminalSessionSchema = z
  .object({ projectId: z.uuid(), sessionId: z.uuid() })
  .strict();
export const terminalInputSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("write"), sessionId: z.uuid(), data: z.string().min(1).max(32_000) })
    .strict(),
  terminalSizeSchema.extend({ kind: z.literal("resize"), sessionId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("ack"),
      sessionId: z.uuid(),
      sequence: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);
export type TerminalInput = z.infer<typeof terminalInputSchema>;
export const terminalOutputSchema = z.discriminatedUnion("kind", [
  terminalSizeSchema.extend({
    kind: z.literal("snapshot"),
    sessionId: z.uuid(),
    sequence: z.number().int().nonnegative().safe(),
    data: z.string().max(1_100_000),
    reset: z.boolean(),
    exited: z.boolean(),
    exitCode: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("data"),
    sessionId: z.uuid(),
    sequence: z.number().int().positive().safe(),
    data: z.string().max(32_000),
  }),
  z.object({ kind: z.literal("exit"), sessionId: z.uuid(), exitCode: z.number().int().nullable() }),
  z.object({ kind: z.literal("error"), message: z.string().max(1000) }),
  z.object({ kind: z.literal("disconnected"), message: z.string().max(1000) }),
]);
export type TerminalOutput = z.infer<typeof terminalOutputSchema>;
export type TerminalWatch = { input(input: TerminalInput): void; close(): void };
export type TerminalAPI = {
  end(session: z.infer<typeof terminalSessionSchema>): Promise<void>;
  watch(scope: TerminalScope, receive: (output: TerminalOutput) => void): TerminalWatch;
};
