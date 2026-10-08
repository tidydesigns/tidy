import { z } from "zod";
import { db } from "@/lib/db";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { CLIPBOARD_LIMITS } from "@/lib/security/resource-limits";
import { designObjectBytes, type StoredImage } from "@/lib/storage/design-objects";
import { admitClipboardTransfer, withClipboardAccess } from "./clipboard-authority";
import { putAsset } from "./document-service";
export { ClipboardAccessError } from "./clipboard-authority";
export { ClipboardBudgetUnavailableError } from "./clipboard-budget";

export class ClipboardTransferError extends Error {}
export const clipboardAssetRequest = z
  .object({
    sourceFile: z.string().min(1).max(120),
    assetIds: z.array(z.string().uuid()).max(5000),
  })
  .strict();
type Asset = StoredImage & { id: string };
type Dependencies = {
  admit: typeof admitClipboardTransfer;
  withAccess: typeof withClipboardAccess;
  assets: (userId: string, organizationId: string, ids: string[]) => Promise<Asset[]>;
  bytes: (
    userId: string,
    organizationId: string,
    asset: Asset,
    maxBytes: number,
    signal: AbortSignal,
  ) => Promise<Buffer>;
  put: typeof putAsset;
};
const dependencies: Dependencies = {
  admit: admitClipboardTransfer,
  withAccess: withClipboardAccess,
  assets: async (userId, organizationId, ids) =>
    (
      await db.query<Asset>(
        `select a."id",a."mimeType",a."objectKey",a."sha256",
    greatest(a."byteSize",octet_length(a."body"))::float8 as "byteSize"
    from "designAsset" a
    join "member" m on m."organizationId"=a."organizationId" and m."userId"=$1 and m."role" in ${VIEW_ROLES_SQL}
    join "user" u on u."id"=m."userId" and u."emailVerified"=true
    where a."organizationId"=$2 and a."id"=any($3::text[]) order by a."id" for share of a,m,u`,
        [userId, organizationId, ids],
      )
    ).rows,
  bytes: (userId, organizationId, asset, maxBytes, signal) =>
    designObjectBytes(
      asset,
      async () =>
        (
          await db.query<{ body: Buffer | null }>(
            `select a."body" from "designAsset" a
      join "member" m on m."organizationId"=a."organizationId" and m."userId"=$1 and m."role" in ${VIEW_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where a."organizationId"=$2 and a."id"=$3 and octet_length(a."body")<=$4`,
            [userId, organizationId, asset.id, maxBytes],
          )
        ).rows[0]?.body ?? null,
      maxBytes,
      signal,
    ),
  put: putAsset,
};

/** Assets removed by a cut may still be copied: source organization ownership
 * and current view permission remain authoritative, independent of node references. */
export async function transferClipboardAssets(
  userId: string,
  fileId: string,
  input: unknown | (() => Promise<unknown>),
  deps: Dependencies = dependencies,
) {
  await deps.admit(userId, fileId);
  const parsed = clipboardAssetRequest.safeParse(
    typeof input === "function" ? await input() : input,
  );
  if (!parsed.success) throw new ClipboardTransferError("Invalid clipboard image request.");
  const request = parsed.data;
  const ids = [...new Set(request.assetIds)];
  return deps.withAccess(userId, request.sourceFile, fileId, async (access) => {
    const crossOrganization = access.sourceOrganizationId !== access.targetOrganizationId;
    if (crossOrganization && ids.length > CLIPBOARD_LIMITS.assetsPerCopy)
      throw new ClipboardTransferError("Clipboard has too many images. Copy a smaller selection.");
    const assets = await deps.assets(userId, access.sourceOrganizationId, ids);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    if (assets.length !== ids.length || ids.some((id) => !byId.has(id)))
      throw new ClipboardTransferError("One or more clipboard images are missing or inaccessible.");
    if (!crossOrganization) return Object.fromEntries(ids.map((id) => [id, id]));
    if (
      assets.some(
        (asset) =>
          !Number.isSafeInteger(asset.byteSize) ||
          asset.byteSize! < 1 ||
          asset.byteSize! > CLIPBOARD_LIMITS.bytesPerImage,
      ) ||
      assets.reduce((sum, asset) => sum + asset.byteSize!, 0) > CLIPBOARD_LIMITS.bytesPerCopy
    )
      throw new ClipboardTransferError(
        "Clipboard images exceed 16 MB or have unknown sizes. Copy a smaller selection.",
      );
    const signal = AbortSignal.timeout(CLIPBOARD_LIMITS.copyDeadlineMs);
    const result: Record<string, string> = {};
    let remaining: number = CLIPBOARD_LIMITS.bytesPerCopy;
    for (const id of ids) {
      signal.throwIfAborted();
      const asset = byId.get(id)!;
      const limit = Math.min(CLIPBOARD_LIMITS.bytesPerImage, remaining);
      const bytes = await deps.bytes(userId, access.sourceOrganizationId, asset, limit, signal);
      if (bytes.length < 1 || bytes.length > limit)
        throw new ClipboardTransferError(
          "Clipboard images exceed the copy allowance. Copy a smaller selection.",
        );
      remaining -= bytes.length;
      result[id] = (
        await deps.put(
          userId,
          access.targetOrganizationId,
          asset.mimeType,
          bytes.toString("base64"),
          signal,
        )
      ).assetId;
    }
    signal.throwIfAborted();
    return result;
  });
}
