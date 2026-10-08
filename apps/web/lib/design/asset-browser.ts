import { db } from "@/lib/db";
import { getDesignFile } from "./service";

export async function listFileAssets(userId: string, fileId: string, cursor?: string | null) {
  const file = await getDesignFile(userId, fileId);
  if (!file) return null;
  let after: { createdAt: string; id: string } | undefined;
  if (cursor) {
    try {
      if (cursor.length > 400) throw new Error();
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        typeof value.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(value.id) ||
        typeof value.createdAt !== "string" ||
        !Number.isFinite(Date.parse(value.createdAt))
      )
        throw new Error();
      after = value;
    } catch {
      throw new Error("Invalid asset cursor.");
    }
  }
  const result = await db.query<{
    id: string;
    mimeType: string;
    byteSize: number;
    createdAt: string;
  }>(
    `select a."id", a."mimeType", coalesce(a."byteSize", octet_length(a."body")) as "byteSize", a."createdAt"::text as "createdAt" from "designAsset" a
     join "member" m on m."organizationId"=a."organizationId" and m."userId"=$2
     where a."organizationId"=$1 and ($3::timestamptz is null or (a."createdAt",a."id") < ($3::timestamptz,$4::text))
     order by a."createdAt" desc, a."id" desc limit 51`,
    [file.organizationId, userId, after?.createdAt ?? null, after?.id ?? null],
  );
  const rows = result.rows.slice(0, 50),
    last = rows.at(-1);
  return {
    assets: rows.map((row) => ({
      assetId: row.id,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
    })),
    nextCursor:
      result.rows.length > 50 && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString(
            "base64url",
          )
        : null,
  };
}
