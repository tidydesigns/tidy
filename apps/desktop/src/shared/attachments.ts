import { z } from "zod";
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  mimeType: z.string().max(100),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export type AttachedFile = Attachment & { previewUrl?: string };
