import "server-only";
import { designImageResponse } from "@/lib/storage/design-objects";
import { IMAGE_READ_LIMITS } from "@/lib/security/resource-limits";
import { withPrivateImageAccess } from "./image-authority";
import { imageFailureResponse } from "./image-budget";

export async function assetResponseForUser(userId: string, id: string, request: Request) {
  try {
    return (
      (await withPrivateImageAccess(userId, id, "asset", null, (client, asset) =>
        designImageResponse(
          asset,
          async () =>
            (
              await client.query<{ body: Buffer | null }>(
                `select a."body" from "designAsset" a where a."id"=$1 and a."organizationId"=$2 and octet_length(a."body")<=$3`,
                [id, asset.organizationId, IMAGE_READ_LIMITS.bytes],
              )
            ).rows[0]?.body ?? null,
          request,
        ),
      )) ?? new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } })
    );
  } catch (error) {
    return imageFailureResponse(error);
  }
}
