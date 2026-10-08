import * as z from "zod";
import { designDocumentSchema } from "@bella/design/document";

export const previewSummarySchema = z.object({
  fileId: z.string().min(1),
  name: z.string(),
  url: z.string().url(),
  revision: z.number().int().positive(),
  roots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      pageId: z.string(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  selectedRootId: z.string().nullable(),
});
export const previewSchema = previewSummarySchema.extend({
  document: designDocumentSchema,
  assets: z.record(
    z.string(),
    z.string().regex(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/),
  ),
  fontUrls: z.array(
    z
      .string()
      .url()
      .refine((url) => new URL(url).origin === "https://fonts.googleapis.com"),
  ),
});
export type DesignPreview = z.infer<typeof previewSchema>;

export function readPreview(result: unknown): DesignPreview | null {
  if (!result || typeof result !== "object" || (result as { isError?: boolean }).isError)
    return null;
  const parsed = previewSchema.safeParse(
    (result as { _meta?: { tidyPreview?: unknown } })._meta?.tidyPreview,
  );
  if (!parsed.success) return null;
  const preview = parsed.data;
  const url = new URL(preview.url);
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    ) ||
    url.pathname !== `/files/${encodeURIComponent(preview.fileId)}` ||
    url.username ||
    url.password
  )
    return null;
  return preview;
}

/** A late refresh must not replace a newer model result or a different file. */
export function acceptPreview(
  current: DesignPreview | null,
  incoming: DesignPreview,
  requestedFile?: string,
) {
  if (requestedFile && current?.fileId !== requestedFile) return current;
  if (current?.fileId === incoming.fileId && incoming.revision < current.revision) return current;
  return incoming;
}
