import { z } from "zod";
import { designDocumentSchema } from "@tidy/design/document";

export const fileVersionSchema = z.object({
  id: z.string(),
  sequence: z.string(),
  revision: z.number().int(),
  name: z.string().nullable(),
  kind: z.enum(["automatic", "named", "beforeRestore"]),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  author: z.string().nullable(),
});
export const fileVersionListSchema = z.object({
  versions: z.array(fileVersionSchema),
  nextCursor: z.string().nullable(),
});
export const versionPreviewSchema = z.object({
  version: fileVersionSchema,
  content: designDocumentSchema,
  currentRevision: z.number().int(),
});
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type VersionPreview = z.infer<typeof versionPreviewSchema>;
