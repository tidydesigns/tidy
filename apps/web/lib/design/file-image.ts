import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { DESIGN_READ_LIMITS } from "@/lib/security/resource-limits";
import { db } from "@/lib/db";
import { nodeAssetIds, type DesignDocument } from "./document";
import { designObjectBytes, type StoredImage } from "@/lib/storage/design-objects";

const unavailable = "File image not found or access denied.";

/** Authorize the file and its asset together before reading private object bytes. */
export async function getFileImage(userId: string, fileId: string, assetId: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<StoredImage & { revision: number; content: DesignDocument }>(
      `select d."revision", d."content", a."mimeType", a."objectKey", a."sha256", a."byteSize"
     from "designFile" f
     join "member" m on m."organizationId" = f."organizationId" and m."userId" = $3 and m."role" in ${VIEW_ROLES_SQL}
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     join "designDocument" d on d."fileId" = f."id"
     join "designAsset" a on a."organizationId" = f."organizationId" and a."id" = $2
     where f."id" = $1 and f."archivedAt" is null for share of f,m,u,a,d`,
      [fileId, assetId, userId],
    );
    const image = result.rows[0];
    if (!image) throw new Error(unavailable);
    const nodes = image.content.nodes.filter((node) => nodeAssetIds(node).includes(assetId));
    if (!nodes.length) throw new Error(unavailable);
    const bytes = await designObjectBytes(
      image,
      async () => {
        const legacy = await client.query<{ body: Buffer | null }>(
          `select a."body" from "designAsset" a
       join "designFile" f on f."organizationId" = a."organizationId" and f."id" = $1 and f."archivedAt" is null
       join "member" m on m."organizationId" = f."organizationId" and m."userId" = $3 and m."role" in ${VIEW_ROLES_SQL}
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
       where a."id" = $2 and octet_length(a."body") <= $4`,
          [fileId, assetId, userId, DESIGN_READ_LIMITS.exportBytes],
        );
        return legacy.rows[0]?.body ?? null;
      },
      DESIGN_READ_LIMITS.exportBytes,
    );
    await client.query("commit");
    return {
      fileId,
      assetId,
      revision: image.revision,
      mimeType: image.mimeType,
      byteSize: bytes.length,
      base64: bytes.toString("base64"),
      layers: nodes.map((node) => ({
        nodeId: node.id,
        name: node.name,
        type: node.type,
        box: node.box,
        imageCrop: node.style.imageCrop,
        paints: node.style.paints,
      })),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
