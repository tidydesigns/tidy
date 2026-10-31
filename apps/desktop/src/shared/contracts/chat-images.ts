import { z } from "zod";

export const MAX_CHAT_IMAGE_BYTES = 16 * 1024 * 1024;
export const CHAT_IMAGE_CHUNK_BYTES = 192 * 1024;

export const chatImageRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    threadId: z.string().uuid(),
    href: z.string().min(1).max(4096),
    offset: z.number().int().min(0).max(MAX_CHAT_IMAGE_BYTES).optional(),
    revision: z.string().min(1).max(200).optional(),
  })
  .strict();

export const chatImageSchema = z.object({
  name: z.string().max(4096),
  dataUrl: z
    .string()
    .max((CHAT_IMAGE_CHUNK_BYTES / 3) * 4 + 32)
    .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  offset: z.number().int().nonnegative().max(MAX_CHAT_IMAGE_BYTES),
  size: z.number().int().positive().max(MAX_CHAT_IMAGE_BYTES),
  revision: z.string().min(1).max(200),
});

export type ChatImageRequest = z.infer<typeof chatImageRequestSchema>;
export type ChatImage = z.infer<typeof chatImageSchema>;
