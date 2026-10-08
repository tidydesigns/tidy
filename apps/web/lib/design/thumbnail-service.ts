import "server-only";
import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { planLimitMessage } from "@/lib/billing/plans";
import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { EDIT_ROLES_SQL } from "@/lib/organizations/roles";
import { IMAGE_READ_LIMITS } from "@/lib/security/resource-limits";
import { fileVersion } from "./file-version";
import { thumbnailVersion } from "./thumbnail-version";
import { designImageResponse, storeDesignObject } from "@/lib/storage/design-objects";
import { withPrivateImageAccess } from "./image-authority";
import { imageFailureResponse, reserveImageOperation } from "./image-budget";
import { OrganizationAccessError, withOrganizationEditAuthority } from "./organization-authority";

const response = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
class ThumbnailChangedError extends Error {}

export async function thumbnailResponseForUser(userId: string, uid: string, request: Request) {
  const version = new URL(request.url).searchParams.get("version");
  try {
    return (
      (await withPrivateImageAccess(userId, uid, "thumbnail", version, (client, image) =>
        designImageResponse(
          image,
          async () =>
            (
              await client.query<{ body: Buffer | null }>(
                `select t."body" from "designFileThumbnail" t where t."fileId"=$1 and t."sha256" is not distinct from $2 and octet_length(t."body")<=$3`,
                [uid, image.sha256, IMAGE_READ_LIMITS.bytes],
              )
            ).rows[0]?.body ?? null,
          request,
        ),
      )) ?? response(404)
    );
  } catch (error) {
    return imageFailureResponse(error);
  }
}

type File = { organizationId: string; updatedAt: Date; revision: number | null };
export async function uploadThumbnailForUser(userId: string, uid: string, request: Request) {
  try {
    if (!uid || uid.length > 120) return response(403);
    // Discovery and the shared attempt reservation retain no product locks.
    const result = await db.query<File>(
      `select f."organizationId",f."updatedAt",d."revision" from "designFile" f
      join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      left join "designDocument" d on d."fileId"=f."id" where f."id"=$1 and f."archivedAt" is null`,
      [uid, userId],
    );
    if (result.rows.length !== 1) return response(403);
    const discovered = result.rows[0]!;
    await reserveImageOperation("thumbnail", userId, discovered.organizationId);
    const version = new URL(request.url).searchParams.get("version");
    if (version !== thumbnailVersion(fileVersion(discovered.updatedAt, discovered.revision)))
      return response(409);
    const body = Buffer.from(await (await boundedRequest(request, 2_000_000)).arrayBuffer());
    if (
      body.length < 33 ||
      body.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      body.subarray(12, 16).toString() !== "IHDR" ||
      body.readUInt32BE(16) < 1 ||
      body.readUInt32BE(20) < 1 ||
      body.readUInt32BE(16) > 1024 ||
      body.readUInt32BE(20) > 1024
    )
      return response(400);
    return await withOrganizationEditAuthority(
      userId,
      discovered.organizationId,
      async (client) => {
        const current = await client.query<Omit<File, "revision">>(
          `select f."organizationId",f."updatedAt" from "designFile" f
        where f."id"=$1 and f."organizationId"=$2 and f."archivedAt" is null for share of f`,
          [uid, discovered.organizationId],
        );
        if (current.rows.length !== 1) return response(403);
        const document = await client.query<{ revision: number }>(
          `select "revision" from "designDocument" where "fileId"=$1 for share`,
          [uid],
        );
        const file = { ...current.rows[0]!, revision: document.rows[0]?.revision ?? null };
        if (version !== thumbnailVersion(fileVersion(file.updatedAt, file.revision)))
          return response(409);
        const { value: stored } = await inDatabaseScope(client, () =>
          storeDesignObject(file.organizationId, "image/png", body, "thumbnail"),
        );
        // The explicit organization binding also protects future changes to discovery/locking.
        const saved = await client.query(
          `insert into "designFileThumbnail" ("fileId","version","mimeType","sha256","objectKey","byteSize","body")
        select f."id",$3,'image/png',$4,$5,$6,$7 from "designFile" f
        left join "designDocument" d on d."fileId"=f."id"
        where f."id"=$1 and f."organizationId"=$2 and f."archivedAt" is null
        and date_trunc('milliseconds',f."updatedAt")=$8::timestamptz and d."revision" is not distinct from $9::integer
        on conflict ("fileId") do update set "version"=excluded."version","mimeType"=excluded."mimeType","sha256"=excluded."sha256",
        "objectKey"=excluded."objectKey","byteSize"=excluded."byteSize","body"=excluded."body"`,
          [
            uid,
            file.organizationId,
            version,
            stored.sha256,
            stored.objectKey,
            stored.byteSize,
            stored.objectKey ? null : body,
            file.updatedAt,
            file.revision,
          ],
        );
        if (!saved.rowCount) throw new ThumbnailChangedError();
        return response(204);
      },
    );
  } catch (error) {
    if (error instanceof RequestBodyError) return requestBodyError(error);
    if (error instanceof OrganizationAccessError) return response(403);
    if (error instanceof ThumbnailChangedError) return response(409);
    const message = planLimitMessage(error);
    if (message)
      return Response.json(
        { error: message, code: "PLAN_LIMIT" },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    return imageFailureResponse(error);
  }
}
