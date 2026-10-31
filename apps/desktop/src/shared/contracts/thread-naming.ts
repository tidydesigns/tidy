import { z } from "zod";

export const threadTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const threadNamingSchema = z
  .object({
    mode: z.enum(["automatic", "prompt"]).default("automatic"),
    provider: z.enum(["thread", "codex", "claude", "opencode"]).default("thread"),
    instructions: z.string().max(1000).default(""),
  })
  .strict();
export type ThreadNaming = z.infer<typeof threadNamingSchema>;
export const defaultThreadNaming: ThreadNaming = threadNamingSchema.parse({});
