import { z } from "zod";

export const assetUploadSchema = z.object({ assetId: z.uuid() });
export const clipboardAssetsSchema = z.object({ assets: z.record(z.string(), z.uuid()) });
export const browserAssetSchema = z.object({
  assetId: z.uuid(),
  mimeType: z.string(),
  // node-postgres serializes bigint columns as decimal strings by default.
  byteSize: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().nonnegative()),
});
export const assetPageSchema = z.object({
  assets: z.array(browserAssetSchema),
  nextCursor: z.string().nullable(),
});
export const assetCursorSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/i),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
export type BrowserAsset = z.infer<typeof browserAssetSchema>;
