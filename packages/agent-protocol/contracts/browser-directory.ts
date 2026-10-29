import { z } from "zod";

export const directorySchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  directories: z.array(z.object({ name: z.string(), path: z.string() })),
  initialProject: z.string(),
});
export type Directory = z.infer<typeof directorySchema>;
export const directoryResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: directorySchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
