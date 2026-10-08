import { IMAGE_READ_LIMITS } from "@/lib/security/resource-limits";
import { withImageReadCapacity } from "@/lib/design/image-capacity";
import {
  designImageResponse,
  designObjectBytes,
  type StoredImage,
} from "@/lib/storage/design-objects";
import { authorizedReviewImageAccess } from "./reviews";
import { withReviewProviderAuthority } from "./review-authority";

async function withAuthorizedReviewImage<T>(
  userId: string,
  reviewId: string,
  imageId: string,
  capture: boolean,
  work: (image: StoredImage, fallback: () => Promise<Buffer | null>) => Promise<T>,
) {
  return withImageReadCapacity(async () => {
    const access = await authorizedReviewImageAccess(userId, reviewId);
    return withReviewProviderAuthority(userId, access, "view", async (client) => {
      const result = capture
        ? await client.query<StoredImage>(
            `select "mimeType","objectKey","sha256",greatest("byteSize",octet_length("body"))::float8 as "byteSize" from "githubCapture" where "id"=$1 and "reviewId"=$2 for share`,
            [imageId, reviewId],
          )
        : await client.query<StoredImage>(
            `select "mimeType","objectKey","sha256",greatest("byteSize",octet_length("body"))::float8 as "byteSize" from "githubReviewAsset" where "assetId"=$1 and "reviewId"=$2 for share`,
            [imageId, reviewId],
          );
      const image = result.rows[0];
      const fallback = async () => {
        const legacy = capture
          ? await client.query<{ body: Buffer | null }>(
              `select "body" from "githubCapture" where "id"=$1 and "reviewId"=$2 and octet_length("body")<=$3`,
              [imageId, reviewId, IMAGE_READ_LIMITS.bytes],
            )
          : await client.query<{ body: Buffer | null }>(
              `select "body" from "githubReviewAsset" where "assetId"=$1 and "reviewId"=$2 and octet_length("body")<=$3`,
              [imageId, reviewId, IMAGE_READ_LIMITS.bytes],
            );
        return legacy.rows[0]?.body ?? null;
      };
      return image ? work(image, fallback) : null;
    });
  });
}
export async function reviewImage(
  userId: string,
  reviewId: string,
  imageId: string,
  capture: boolean,
  request?: Request,
) {
  return (
    (await withAuthorizedReviewImage(userId, reviewId, imageId, capture, (image, fallback) =>
      designImageResponse(image, fallback, request),
    )) ?? new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } })
  );
}
export async function reviewImageBytes(
  userId: string,
  reviewId: string,
  imageId: string,
  capture: boolean,
) {
  const image = await withAuthorizedReviewImage(
    userId,
    reviewId,
    imageId,
    capture,
    async (stored, fallback) => ({
      mimeType: stored.mimeType,
      body: await designObjectBytes(stored, fallback, IMAGE_READ_LIMITS.bytes),
    }),
  );
  if (!image) throw new Error("Review image not found.");
  return image;
}
