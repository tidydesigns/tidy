import { z } from "zod";

export const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
export const VIDEO_CHUNK_BYTES = 512 * 1024;

export function videoMimeType(path: string) {
  switch (path.split(".").at(-1)?.toLowerCase()) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "ogv":
      return "video/ogg";
    default:
      return null;
  }
}

export const videoChunkRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    threadId: z.string().uuid(),
    href: z.string().min(1).max(4096),
    offset: z.number().int().min(0).max(MAX_VIDEO_BYTES),
    revision: z.string().max(200).optional(),
  })
  .strict();

export const videoChunkSchema = z.object({
  data: z
    .string()
    .max(Math.ceil(VIDEO_CHUNK_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  size: z.number().int().positive().max(MAX_VIDEO_BYTES),
  mimeType: z.enum(["video/mp4", "video/webm", "video/quicktime", "video/ogg"]),
  revision: z.string().min(1).max(200),
});
export type VideoChunkRequest = z.infer<typeof videoChunkRequestSchema>;
export type VideoChunk = z.infer<typeof videoChunkSchema>;
