import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { db } from "@/lib/db";
import type { DesignDocument } from "./document";
import type { DocumentPatch } from "./document-patch";

export type RevisionPatch = { baseRevision: number; revision: number; patch: DocumentPatch };
export type FileChanges = {
  name: string;
  role: string;
  revision: number;
  sequence: string;
  content: DesignDocument | null;
  patches: RevisionPatch[] | null;
};

/** One MVCC statement; gaps, non-command edits and oversized catch-up use a snapshot. */
export async function readFileChanges(userId: string, fileId: string, revision: number | null) {
  const result = await db.query<FileChanges>(
    `
    with authorized as (
      select m."role", f."name", d."revision", d."content", coalesce(s."sequence",0) as "sequence"
      from "designFile" f join "designDocument" d on d."fileId" = f."id"
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${VIEW_ROLES_SQL}
      join "user" u on u."id" = m."userId" and u."emailVerified" = true
      left join "designRealtimeState" s on s."fileId" = f."id"
      where f."id" = $1 and f."archivedAt" is null
    ), catchup as (
      select a.*, p.patches, p.count, p.valid,
        ($3::integer is not null and ($3 = a."revision" or
          ($3 < a."revision" and p.count = a."revision" - $3 and p.valid and octet_length(p.patches::text) <= 1000000))) as delta
      from authorized a left join lateral (
        select jsonb_agg(jsonb_build_object('baseRevision', o."baseRevision", 'revision', o."revision", 'patch', o."patch") order by o."revision") as patches,
          count(*)::integer as count, bool_and(o."baseRevision" = o."revision" - 1) as valid
        from (select "baseRevision", "revision", "patch" from "designRealtimeOperation"
          where "fileId" = $1 and "revision" > $3 and "revision" <= a."revision"
            and jsonb_array_length("patch") > 0
          order by "revision" limit 101) o
      ) p on $3::integer is not null and a."revision" > $3 and a."revision" - $3 <= 100
    )
    select "role", "name", "revision", "sequence",
      case when delta then null else "content" end as content,
      case when delta then coalesce(patches, '[]'::jsonb) else null end as patches
    from catchup`,
    [fileId, userId, revision],
  );
  return result.rows[0] ?? null;
}
