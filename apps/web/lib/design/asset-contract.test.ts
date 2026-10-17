import { expect, test } from "bun:test";
import { assetPageSchema, assetUploadSchema, clipboardAssetsSchema } from "./asset-contract";

test("asset contracts accept older decimal byte sizes without allowing imprecise or malformed sizes", () => {
  const asset = { assetId: crypto.randomUUID(), mimeType: "image/png", byteSize: "2000000" };
  expect(assetPageSchema.parse({ assets: [asset], nextCursor: null }).assets[0].byteSize).toBe(
    2000000,
  );
  for (const byteSize of ["", "NaN", "-1", "1.5", "9007199254740992", null]) {
    expect(
      assetPageSchema.safeParse({ assets: [{ ...asset, byteSize }], nextCursor: null }).success,
    ).toBe(false);
  }
  expect(assetUploadSchema.safeParse({ assetId: null }).success).toBe(false);
  expect(clipboardAssetsSchema.safeParse({ assets: { source: null } }).success).toBe(false);
});
