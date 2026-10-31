import { z } from "zod";

export const chatImageRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    threadId: z.string().uuid(),
    href: z.string().min(1).max(4096),
  })
  .strict();

export const chatImageSchema = z.object({
  name: z.string().max(4096),
  dataUrl: z
    .string()
    .max(23_000_000)
    .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
});

export type ChatImageRequest = z.infer<typeof chatImageRequestSchema>;
export type ChatImage = z.infer<typeof chatImageSchema>;
