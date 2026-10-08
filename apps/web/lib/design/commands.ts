import {
  DOCUMENT_HISTORY_LIMITS,
  ExpiredDocumentEdit,
  retainDocumentHistory,
} from "./history-retention";
import { EDIT_ROLES_SQL } from "@/lib/organizations/roles";
import { documentAssetIds } from "./document";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { applyDocumentPatch, diffDocument, type DocumentPatch } from "./document-patch";
import { trackDocumentChanges } from "./edit-document";
import { syncComponentEdit } from "./component-sync";
import { designNodeChangesSchema, parseDesignDocument } from "./document";
import type { DesignDocument } from "./document";
import { publishFileChanges } from "@/lib/realtime/server";

export async function commitDocumentPatch(
  userId: string,
  fileId: string,
  operationId: string,
  requestRevision: number,
  patch: DocumentPatch,
  conditional: boolean,
  sourceNodeId?: string,
  expectedSequence?: number,
  allowedSequences?: number[],
  restore?: { versionId: string; expectedRevision: number },
) {
  if (!Number.isSafeInteger(requestRevision) || requestRevision < 0 || requestRevision > 2147483647)
    throw new Error("A valid base revision is required.");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        requestRevision,
        patch,
        conditional,
        sourceNodeId,
        expectedSequence,
        allowedSequences,
        restore,
      }),
    )
    .digest("hex");
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query<{ organizationId: string }>(
      `select f."organizationId" from "designFile" f
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id" = m."userId" and u."emailVerified" = true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m, u`,
      [fileId, userId],
    );
    if (!access.rows[0]) throw new Error("File not found or access denied.");
    const row = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    const current = row.rows[0];
    if (!current) throw new Error("Document not found.");
    if (requestRevision > current.revision)
      throw new Error("The base revision is ahead of this file.");
    // Expiry and receipt deletion share this transaction and the file lock.
    await retainDocumentHistory(client, fileId);
    const floor = await client.query<{ replayFloorRevision: number; historyFloorSequence: string }>(
      `select "replayFloorRevision", "historyFloorSequence" from "designRealtimeState" where "fileId"=$1`,
      [fileId],
    );
    if (requestRevision < (floor.rows[0]?.replayFloorRevision ?? 0))
      throw new ExpiredDocumentEdit();
    const prior = await client.query<{
      userId: string;
      hash: string;
      patch: DocumentPatch;
      sequence: string;
      baseRevision: number | null;
      revision: number | null;
    }>(
      `select "userId", "hash", "patch", "sequence", "baseRevision", "revision" from "designRealtimeOperation" where "fileId" = $1 and "operationId" = $2`,
      [fileId, operationId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].userId !== userId || prior.rows[0].hash !== hash)
        throw new Error("Operation ID was already used for a different edit.");
      await client.query("commit");
      await publishFileChanges(fileId);
      return {
        snapshot: current,
        patch: prior.rows[0].patch,
        sequence: Number(prior.rows[0].sequence),
        baseRevision: prior.rows[0].baseRevision,
        committedRevision: prior.rows[0].revision,
      };
    }
    if (conditional) {
      if (expectedSequence === undefined)
        throw new Error("Undo requires the original edit version.");
      if (expectedSequence < Number(floor.rows[0]?.historyFloorSequence ?? 0))
        throw new Error("This undo history has expired.");
      const allowed = [...new Set(allowedSequences ?? [])];
      if (allowed.length) {
        const owned = await client.query<{ sequence: string }>(
          `select distinct "sequence" from "designRealtimeOperation"
          where "fileId"=$1 and "userId"=$2 and "sequence"=any($3::bigint[]) and jsonb_array_length("patch")>0`,
          [fileId, userId, allowed],
        );
        if (owned.rows.length !== allowed.length)
          throw new Error("Undo references an unavailable edit version.");
      }
    }
    let beforeVersionId: string | undefined;
    let content;
    if (restore) {
      if (conditional || sourceNodeId || patch.length)
        throw new Error("A version restore cannot include other edits.");
      if (current.revision !== restore.expectedRevision)
        throw new Error("The file changed. Close history to review it, then reopen this version.");
      const version = (
        await client.query<{ content: DesignDocument; name: string | null; revision: number }>(
          'select "content","name","revision" from "designFileVersion" where "fileId"=$1 and "id"=$2',
          [fileId, restore.versionId],
        )
      ).rows[0];
      if (!version) throw new Error("Version not found or access denied.");
      content = {
        ...parseDesignDocument(version.content),
        commentPages: current.content.commentPages,
      };
      beforeVersionId = randomUUID();
      await client.query(
        'insert into "designFileVersion" ("id","fileId","revision","content","name","kind","createdBy","createdByName") values ($1,$2,$3,$4::jsonb,$5,\'beforeRestore\',$6,(select "name" from "user" where "id"=$6))',
        [
          beforeVersionId,
          fileId,
          current.revision,
          JSON.stringify(current.content),
          `Before restoring ${version.name ?? `revision ${version.revision}`}`.slice(0, 120),
          userId,
        ],
      );
    } else content = applyDocumentPatch(current.content, patch, conditional);
    if (sourceNodeId && !conditional) {
      const allowed = new Set(Object.keys(designNodeChangesSchema.shape));
      const changes: Parameters<typeof syncComponentEdit>[2] = {};
      for (const change of patch.filter(
        (item) =>
          item.collection === "nodes" &&
          item.id === sourceNodeId &&
          item.path.length &&
          allowed.has(item.path[0]),
      )) {
        const [key, child] = change.path;
        if (child && (key === "style" || key === "box" || key === "tokenBindings"))
          Object.assign(changes, {
            [key]: {
              ...changes[key],
              [child]: change.after.exists ? change.after.value : undefined,
            },
          });
        else if (change.path.length === 1)
          Object.assign(changes, { [key]: change.after.exists ? change.after.value : undefined });
      }
      // The authoritative tree may contain instances created after the client's
      // base. Apply master propagation here so those instances also update.
      content = parseDesignDocument({
        ...content,
        nodes: syncComponentEdit(content.nodes, sourceNodeId, changes),
      });
    }
    if (!conditional) content = trackDocumentChanges(current.content, content);
    const assetIds = documentAssetIds(content);
    if (assetIds.length) {
      const assets = await client.query(
        `select "id" from "designAsset" where "organizationId" = $1 and "id" = any($2::text[])`,
        [access.rows[0].organizationId, assetIds],
      );
      if (assets.rowCount !== assetIds.length)
        throw new Error("One or more assets are inaccessible.");
    }
    const canonical = diffDocument(current.content, content);
    if (conditional) {
      const allowed = [...new Set(allowedSequences ?? [])];
      for (const change of canonical) {
        if (
          change.path[0] === "$order" ||
          change.path[0] === "instanceOverrides" ||
          (change.collection === "document" &&
            ["editedNodeIds", "deletedSourceKeys"].includes(change.path[0]))
        )
          continue;
        const newer = await client.query(
          `select 1 from "designRealtimeProperty" where "fileId"=$1 and "collection"=$2 and "entityId"=$3 and "sequence">$4
          and not ("sequence"=any($6::bigint[]))
          and ("path"[1:cardinality($5::text[])]=$5::text[] or ($5::text[])[1:cardinality("path")]="path") limit 1`,
          [fileId, change.collection, change.id ?? "", expectedSequence, change.path, allowed],
        );
        if (newer.rowCount) throw new Error("This edit changed elsewhere and cannot be undone.");
      }
    }
    const encodedPatch = JSON.stringify(canonical);
    if (Buffer.byteLength(encodedPatch) > DOCUMENT_HISTORY_LIMITS.operationBytes)
      throw new Error("This edit is too large. Split it into smaller edits.");
    // Even no-ops advance the retry boundary, preventing unlimited receipts at one revision.
    const revision = current.revision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(content)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    const sequence = Number(
      (
        await client.query<{ sequence: string }>(
          `select "sequence" from "designRealtimeState" where "fileId"=$1`,
          [fileId],
        )
      ).rows[0]?.sequence ?? 0,
    );
    await client.query(
      `insert into "designRealtimeOperation" ("fileId", "operationId", "userId", "hash", "patch", "sequence", "baseRevision", "revision", "requestRevision") values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [
        fileId,
        operationId,
        userId,
        hash,
        encodedPatch,
        sequence,
        current.revision,
        revision,
        requestRevision,
      ],
    );
    await retainDocumentHistory(client, fileId);
    if (restore && beforeVersionId)
      await client.query(
        'insert into "designFileRestore" ("fileId","operationId","restoredVersionId","beforeVersionId","createdBy","createdByName","revision") values ($1,$2,$3,$4,$5,(select "name" from "user" where "id"=$5),$6)',
        [fileId, operationId, restore.versionId, beforeVersionId, userId, revision],
      );
    await client.query("commit");
    await publishFileChanges(fileId);
    return {
      snapshot: { revision, content },
      patch: canonical,
      sequence,
      baseRevision: current.revision,
      committedRevision: revision,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
