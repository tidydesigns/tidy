import { z } from "zod";

export const videoArtifactSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  sourceHref: z.string().min(1).max(4096),
  status: z.enum(["queued", "processing", "ready", "failed", "cancelled"]),
  error: z.string().max(500).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
  codec: z.string().max(100).optional(),
  transcoded: z.boolean().optional(),
  original: z
    .object({ size: z.number().int().positive(), mimeType: z.string().max(100) })
    .optional(),
  playback: z
    .object({ size: z.number().int().positive(), mimeType: z.enum(["video/mp4", "video/webm"]) })
    .optional(),
  poster: z.boolean().optional(),
  playbackUsesOriginal: z.boolean().optional(),
});
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export const videoReferenceSchema = z
  .object({
    projectId: z.uuid(),
    threadId: z.uuid(),
    artifactId: z.uuid(),
  })
  .strict();
export type VideoReference = z.infer<typeof videoReferenceSchema>;
export const videoVariantSchema = z.enum(["original", "playback", "poster"]);
export type VideoVariant = z.infer<typeof videoVariantSchema>;
export const VIDEO_CHUNK_BYTES = 1024 * 1024;
export const videoReadSchema = videoReferenceSchema
  .extend({
    variant: videoVariantSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .max(2 ** 40),
    length: z.number().int().min(0).max(VIDEO_CHUNK_BYTES),
  })
  .strict();
export type VideoRead = z.infer<typeof videoReadSchema>;
export const videoMetadataSchema = z.object({
  size: z.number().int().positive(),
  mimeType: z.enum([
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska",
    "video/x-msvideo",
    "application/octet-stream",
    "image/jpeg",
  ]),
  name: z.string().max(200),
});
export const videoChunkSchema = videoMetadataSchema.extend({
  base64: z.string().max(Math.ceil(VIDEO_CHUNK_BYTES / 3) * 4),
});
export type VideoChunk = z.infer<typeof videoChunkSchema>;
