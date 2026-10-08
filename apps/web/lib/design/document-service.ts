import { PublicActionError } from "@/lib/security/public-error";
import { withOrganizationEditAuthority } from "./organization-authority";
import { inDatabaseScope } from "@/lib/database-scope";
import { IMPORT_LIMITS, DESIGN_READ_LIMITS } from "@/lib/security/resource-limits";
import { requestWork } from "@/lib/request-work";
import {
  designObjectBytes,
  storeDesignObject,
  type StoredImage,
} from "@/lib/storage/design-objects";
import { EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { documentAssetIds } from "@/lib/design/document";
import { publishFileChanges } from "@/lib/realtime/server";
import type { DesignNodeChanges } from "@/lib/design/document";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { cleanDesignName } from "@/lib/design/service";
import {
  buildDrawnNode,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "@/lib/design/document";
import { mergeImport } from "@/lib/design/merge-import";
import { duplicateNodeTree } from "@/lib/design/duplicate-node";
import { legacyToDocument } from "@/lib/design/legacy-to-document";
import { changedLayers } from "@/lib/design/edit-document";
import { trackDocumentChanges } from "@/lib/design/edit-document";
import { removeComponentReferences } from "./component-variants";
import { layoutReport } from "./layout-diagnostics";
import type { ExportAsset } from "./code-export";
import { summarizeImportChunks } from "@/lib/mcp/activity-summary";
import {
  validDesignFrame,
  validDesignRectangle,
  type DesignFrame,
  type DesignRectangle,
  type FrameInput,
  type RectangleInput,
} from "@/lib/design/service";

type ImportRow = {
  id: string;
  organizationId: string;
  fileId: string | null;
  name: string;
  expectedRevision: number | null;
  chunks: Record<
    string,
    {
      nodes: unknown[];
      source?: unknown;
      warnings?: unknown[];
      tokens?: unknown;
      designTokens?: unknown;
    }
  >;
  status: string;
  committedRevision: number | null;
};

export async function documentSchemaReady() {
  return requestWork("documentSchemaReady", async () => {
    const result = await db.query<{ ready: boolean }>(`select
    to_regclass('"designDocument"') is not null and
    to_regclass('"designAsset"') is not null and
    to_regclass('"designImport"') is not null as ready`);
    return result.rows[0]?.ready === true;
  });
}

async function requireDocumentSchema() {
  if (!(await documentSchemaReady()))
    throw new PublicActionError("Editable imports are unavailable. Try again later.");
}

async function readDocument(userId: string, fileId: string) {
  if (!(await documentSchemaReady())) return null;
  const result = await db.query<{ revision: number; content: DesignDocument }>(
    `select d."revision", d."content" from "designDocument" d join "designFile" f on f."id" = d."fileId"
     join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where d."fileId" = $1 and m."role" in ${VIEW_ROLES_SQL} and f."archivedAt" is null`,
    [fileId, userId],
  );
  return result.rows[0] ?? null;
}

// Archived files are snapshots: even legacy conversion must not write on view.
async function readArchivedEditorDocument(userId: string, fileId: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<{ revision: number | null; content: DesignDocument | null }>(
      `select d."revision", d."content" from "designFile" f
     join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     left join "designDocument" d on d."fileId" = f."id"
     where f."id" = $1 and m."role" in ${VIEW_ROLES_SQL} and f."archivedAt" is not null
     for share of f,m,u`,
      [fileId, userId],
    );
    const current = result.rows[0];
    if (!current) {
      await client.query("commit");
      return null;
    }
    if (current.content?.legacyConverted) {
      await client.query("commit");
      return { revision: current.revision ?? 0, content: current.content };
    }
    const [frames, rectangles] = await Promise.all([
      client.query<DesignFrame>(
        `select "id", "x", "y", "width", "height" from "designFrame" where "fileId" = $1 order by "createdAt", "id"`,
        [fileId],
      ),
      client.query<DesignRectangle>(
        `select "id", "x", "y", "width", "height" from "designRectangle" where "fileId" = $1 order by "createdAt", "id"`,
        [fileId],
      ),
    ]);
    const legacy = legacyToDocument(frames.rows, rectangles.rows);
    const existingIds = new Set(current.content?.nodes.map((node) => node.id) ?? []);
    const snapshot = {
      revision: current.revision ?? 0,
      content: parseDesignDocument({
        ...(current.content ?? legacy),
        nodes: [
          ...(current.content?.nodes ?? []),
          ...legacy.nodes.filter((node) => !existingIds.has(node.id)),
        ],
        legacyConverted: true,
      }),
    };
    await client.query("commit");
    return snapshot;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getExportAssets(userId: string, assetIds: string[]): Promise<ExportAsset[]> {
  if (!assetIds.length) return [];
  if (
    assetIds.length > DESIGN_READ_LIMITS.assetsPerExport ||
    assetIds.some((id) => typeof id !== "string" || id.length > 200)
  )
    throw new PublicActionError("Export has too many assets. Export a smaller component.");
  const ids = [...new Set(assetIds)];
  const client = await db.connect();
  try {
    await client.query("begin");
    // Read metadata first: do not load oversized legacy bodies to discover their size.
    const result = await client.query<StoredImage & { id: string; measuredBytes: number | null }>(
      `select a."id", a."mimeType", a."objectKey", a."sha256", a."byteSize",
      greatest(octet_length(a."body"),a."byteSize")::float8 as "measuredBytes" from "designAsset" a
      join "member" m on m."organizationId"=a."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where a."id"=any($1::text[]) order by a."organizationId",a."id" for share of a,m,u`,
      [ids, userId],
    );
    if (result.rows.length !== ids.length)
      throw new PublicActionError("One or more assets are missing or inaccessible.");
    if (
      result.rows.some((a) => !Number.isSafeInteger(a.measuredBytes) || a.measuredBytes! <= 0) ||
      result.rows.reduce((sum, a) => sum + a.measuredBytes!, 0) > DESIGN_READ_LIMITS.exportBytes
    )
      throw new PublicActionError(
        "Export assets exceed 12 MB or have unknown sizes. Export a smaller component.",
      );
    const signal = AbortSignal.timeout(DESIGN_READ_LIMITS.exportDeadlineMs);
    let remaining: number = DESIGN_READ_LIMITS.exportBytes;
    const assets: ExportAsset[] = [];
    for (const asset of result.rows) {
      const bytes = await designObjectBytes(
        asset,
        async () =>
          (
            await client.query<{ body: Buffer | null }>(
              `select "body" from "designAsset" where "id"=$1 and octet_length("body") <= $2`,
              [asset.id, remaining],
            )
          ).rows[0]?.body ?? null,
        remaining,
        signal,
      );
      remaining -= bytes.length;
      assets.push({ id: asset.id, mimeType: asset.mimeType, base64: bytes.toString("base64") });
    }
    await client.query("commit");
    return assets;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Lazy legacy conversion is a system-maintained representation, not a user edit.
// Viewers need this too, so they can view and comment on files created before documents.
async function readEditorDocument(userId: string, fileId: string) {
  const ready = await readDocument(userId, fileId);
  if (ready?.content.legacyConverted) return ready;
  if (!ready) await requireDocumentSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query(
      `select f."id" from "designFile" f
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and m."role" in ${VIEW_ROLES_SQL} and f."archivedAt" is null
      for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("File not found or access denied.");
    const existing = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    const current = existing.rows[0];
    if (current?.content.legacyConverted) {
      await client.query("commit");
      return current;
    }
    const frames = await client.query<DesignFrame>(
      `select "id", "x", "y", "width", "height" from "designFrame" where "fileId" = $1 order by "createdAt", "id"`,
      [fileId],
    );
    const rectangles = await client.query<DesignRectangle>(
      `select "id", "x", "y", "width", "height" from "designRectangle" where "fileId" = $1 order by "createdAt", "id"`,
      [fileId],
    );
    const legacyNodes = legacyToDocument(frames.rows, rectangles.rows).nodes;
    const existingIds = new Set(current?.content.nodes.map((node) => node.id) ?? []);
    const content = parseDesignDocument({
      ...(current?.content ?? legacyToDocument([], [])),
      nodes: [
        ...(current?.content.nodes ?? []),
        ...legacyNodes.filter((node) => !existingIds.has(node.id)),
      ],
      legacyConverted: true,
    });
    const revision = current ? current.revision + 1 : 1;
    if (current)
      await client.query(
        `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
        [fileId, revision, JSON.stringify(content)],
      );
    else
      await client.query(
        `insert into "designDocument" ("fileId", "revision", "content") values ($1, $2, $3::jsonb)`,
        [fileId, revision, JSON.stringify(content)],
      );
    await client.query("commit");
    await publishFileChanges(fileId);
    return { revision, content };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendBasicNodes(
  userId: string,
  fileId: string,
  kind: "frame" | "rectangle",
  boxes: (FrameInput | RectangleInput)[],
) {
  if (
    boxes.length < 1 ||
    boxes.length > 50 ||
    boxes.some((box) => !(kind === "frame" ? validDesignFrame(box) : validDesignRectangle(box)))
  ) {
    throw new PublicActionError("Provide 1–50 valid shapes.");
  }
  const current = await ensureEditorDocument(userId, fileId);
  const added = boxes.map((box) => ({
    ...buildDrawnNode(randomUUID(), kind === "frame" ? "artboard" : "container", null, box),
    pageId: current.content.pages?.[0].id ?? "page-1",
  }));
  const content = parseDesignDocument({
    ...current.content,
    nodes: [...current.content.nodes, ...added],
  });
  await replaceDocumentForHistory(userId, fileId, current.revision, content);
  return added.map((node) => ({ id: node.id, ...node.box }));
}

export async function replaceDocumentForHistory(
  userId: string,
  fileId: string,
  expectedRevision: number,
  content: DesignDocument,
) {
  await requireDocumentSchema();
  const document = parseDesignDocument(content);
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query<{ organizationId: string }>(
      `select f."organizationId" from "designFile" f
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rows[0]) throw new PublicActionError("File not found or access denied.");
    const current = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    if (current.rows[0]?.revision !== expectedRevision)
      throw new PublicActionError("Document changed. Refresh before editing.");
    // Comment ownership changes independently of canvas history; never restore an older mapping.
    document.commentPages = current.rows[0].content.commentPages;
    await verifyAssets(client, access.rows[0].organizationId, document);
    const revision = expectedRevision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query("commit");
    await publishFileChanges(fileId);
    return { revision };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createImport(
  userId: string,
  organizationId: string,
  name: string,
  fileId?: string,
): Promise<{
  importId: string;
  fileId?: string | null;
  expectedRevision: number | null;
  expiresInHours: number;
  maxNodes: number;
  maxChunkNodes: number;
}> {
  await requireDocumentSchema();
  const cleanName = cleanDesignName(name);
  if (!cleanName) throw new PublicActionError("Enter a file name of up to 120 characters.");
  const member = await db.query(
    `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u`,
    [organizationId, userId],
  );
  if (!member.rowCount) throw new PublicActionError("Organization not found or access denied.");
  let expectedRevision: number | null = null;
  if (fileId) {
    const file = await db.query<{
      revision: number | null;
      frameCount: number;
      rectangleCount: number;
    }>(
      `select d."revision",
         (select count(*)::int from "designFrame" where "fileId" = f."id") as "frameCount",
         (select count(*)::int from "designRectangle" where "fileId" = f."id") as "rectangleCount"
       from "designFile" f left join "designDocument" d on d."fileId" = f."id"
       where f."id" = $1 and f."organizationId" = $2 and f."archivedAt" is null`,
      [fileId, organizationId],
    );
    if (!file.rows[0]) throw new PublicActionError("File not found or access denied.");
    if (file.rows[0].frameCount || file.rows[0].rectangleCount)
      await ensureEditorDocument(userId, fileId);
    expectedRevision = (await getDocument(userId, fileId))?.revision ?? 0;
  }
  const id = randomUUID();
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [organizationId]);
    // Serialize admission per organization; concurrent callers cannot all claim
    // the final draft slot. Only this organization's expired/aborted data is removed.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `imports:${organizationId}`,
    ]);
    const authority = await client.query(
      `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u`,
      [organizationId, userId],
    );
    if (!authority.rowCount)
      throw new PublicActionError("Organization not found or access denied.");
    if (fileId) {
      const parent = await client.query(
        `select "id" from "designFile" where "id"=$1 and "organizationId"=$2 and "archivedAt" is null for share`,
        [fileId, organizationId],
      );
      if (!parent.rowCount) throw new PublicActionError("File not found or access denied.");
    }
    await client.query(
      `delete from "designImport" where "organizationId"=$1 and ("expiresAt"<=now() or "status"='aborted')`,
      [organizationId],
    );
    const count = (
      await client.query<{ total: number; pending: number }>(
        `select count(*)::int as total,
      count(*) filter (where "userId"=$2 and "status"='staging')::int as pending from "designImport" where "organizationId"=$1`,
        [organizationId, userId],
      )
    ).rows[0];
    if (
      count.total >= IMPORT_LIMITS.recordsPerOrganization ||
      count.pending >= IMPORT_LIMITS.pendingPerUserPerOrganization
    ) {
      throw new PublicActionError(
        "Import allowance reached. Finish or abort a pending import, or wait for old imports to expire.",
      );
    }
    const inserted = await client.query(
      `insert into "designImport" ("id","userId","organizationId","fileId","name","expectedRevision")
      select $1,$2,$3,$4,$5,$6 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."userId"=$2 and m."organizationId"=$3 and m."role" in ${EDIT_ROLES_SQL}
        and ($4::text is null or exists (select 1 from "designFile" f where f."id"=$4 and f."organizationId"=$3 and f."archivedAt" is null))`,
      [id, userId, organizationId, fileId ?? null, cleanName, expectedRevision],
    );
    if (!inserted.rowCount) throw new PublicActionError("Organization or file access denied.");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return {
    importId: id,
    fileId: fileId ?? null,
    expectedRevision,
    expiresInHours: 24,
    maxNodes: 5000,
    maxChunkNodes: 250,
  };
}

export async function putImportChunk(
  userId: string,
  importId: string,
  chunkId: string,
  nodes: unknown[],
  source?: unknown,
  warnings?: unknown[],
  tokens?: unknown,
  designTokens?: unknown,
) {
  await requireDocumentSchema();
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(chunkId) ||
    nodes.length > 250 ||
    Buffer.byteLength(JSON.stringify({ nodes, source, warnings, tokens, designTokens }), "utf8") >
      IMPORT_LIMITS.bytesPerChunk
  )
    throw new PublicActionError("Invalid or oversized import chunk.");
  const chunk = { nodes, source, warnings, tokens, designTokens };
  const result = await db.query<{ chunks: Record<string, unknown> }>(
    `update "designImport" set "chunks" = "chunks" || jsonb_build_object($3::text, $4::jsonb)
     where "id" = $1 and "userId" = $2 and "status" = 'staging' and "expiresAt" > now()
       and exists (select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
        where m."organizationId" = "designImport"."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u)
      and ("designImport"."fileId" is null or exists (
        select 1 from "designFile" f where f."id"="designImport"."fileId"
        and f."organizationId"="designImport"."organizationId" and f."archivedAt" is null for share of f
      ))
       and (not ("chunks" ? $3::text) or "chunks"->($3::text) = $4::jsonb)
       and ("chunks" ? $3::text or (select count(*) from jsonb_object_keys("chunks")) < $5)
       and octet_length(("chunks" || jsonb_build_object($3::text, $4::jsonb))::text) <= $6
       and (select coalesce(sum(jsonb_array_length(value->'nodes')),0) from jsonb_each("chunks" || jsonb_build_object($3::text, $4::jsonb))) <= $7
     returning "chunks"`,
    [
      importId,
      userId,
      chunkId,
      JSON.stringify(chunk),
      IMPORT_LIMITS.chunksPerImport,
      IMPORT_LIMITS.bytesPerImport,
      IMPORT_LIMITS.nodesPerImport,
    ],
  );
  if (!result.rows[0])
    throw new PublicActionError("Import unavailable, conflicting, or staging allowance exceeded.");
  return {
    chunkId,
    chunkCount: Object.keys(result.rows[0].chunks).length,
    ...summarizeImportChunks(result.rows[0].chunks),
  };
}

function assemble(chunks: ImportRow["chunks"]): DesignDocument {
  const ordered = Object.entries(chunks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
  if (!ordered.length) throw new PublicActionError("Import has no chunks.");
  const source = ordered.find((chunk) => chunk.source)?.source as DesignDocument["source"];
  const tokens = Object.assign(
    {},
    ...ordered.map((chunk) => chunk.tokens ?? {}),
  ) as DesignDocument["tokens"];
  const importKey = source ? `${source.project}:${source.route}` : undefined;
  return parseDesignDocument({
    schemaVersion: 1,
    legacyConverted: true,
    nodes: ordered
      .flatMap((chunk) => chunk.nodes)
      .map((node) => ({ ...(node as object), importKey })),
    source,
    tokens,
    designTokens: Object.assign({}, ...ordered.map((chunk) => chunk.designTokens ?? {})),
    warnings: ordered.flatMap((chunk) => chunk.warnings ?? []),
  });
}

async function loadImport(userId: string, importId: string): Promise<ImportRow> {
  const result = await db.query<ImportRow>(
    `select "id", "organizationId", "fileId", "name", "expectedRevision", "chunks", "status", "committedRevision"
    from "designImport" where "id" = $1 and "userId" = $2 and "expiresAt" > now()
      and exists (select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
        where m."organizationId" = "designImport"."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u)
      and ("designImport"."fileId" is null or exists (
        select 1 from "designFile" f where f."id"="designImport"."fileId"
        and f."organizationId"="designImport"."organizationId" and f."archivedAt" is null for share of f
      ))`,
    [importId, userId],
  );
  if (!result.rows[0]) throw new PublicActionError("Import not found or expired.");
  return result.rows[0];
}

async function verifyAssets(
  client: { query: typeof db.query },
  organizationId: string,
  document: DesignDocument,
) {
  const assetIds = documentAssetIds(document);
  if (!assetIds.length) return;
  const result = await client.query(
    `select "id" from "designAsset" where "organizationId" = $1 and "id" = any($2::text[])`,
    [organizationId, assetIds],
  );
  if (result.rowCount !== assetIds.length)
    throw new PublicActionError("One or more assets are missing or inaccessible.");
}

export async function validateImport(userId: string, importId: string) {
  await requireDocumentSchema();
  const staging = await loadImport(userId, importId);
  if (staging.status !== "staging") throw new PublicActionError("Import is already committed.");
  const document = assemble(staging.chunks);
  await verifyAssets(db, staging.organizationId, document);
  return {
    nodeCount: document.nodes.length,
    artboardCount: document.nodes.filter((node) => node.type === "artboard").length,
    warnings: document.warnings,
    layout: layoutReport(document),
  };
}

export type ImportCommitResult = {
  fileId: string;
  revision: number;
  url: string;
  alreadyCommitted?: boolean;
  nodeCount?: number;
  importedNodeCount?: number;
  nodeIds?: string[];
  warnings?: DesignDocument["warnings"];
} & import("@/lib/realtime/agent-activity").ActivityDetails;

export async function commitImport(
  userId: string,
  importId: string,
  resolution?: "keep_user" | "use_import" | "duplicate",
): Promise<ImportCommitResult> {
  await requireDocumentSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const owned = await client.query<{ organizationId: string }>(
      `select i."organizationId" from "designImport" i
      join "member" m on m."organizationId"=i."organizationId" and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where i."id"=$1 and i."userId"=$2 and i."expiresAt">now()`,
      [importId, userId],
    );
    if (!owned.rows[0]) throw new PublicActionError("Import not found or expired.");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      owned.rows[0].organizationId,
    ]);
    const result = await client.query<ImportRow>(
      `select "id", "organizationId", "fileId", "name", "expectedRevision", "chunks", "status", "committedRevision"
      from "designImport" where "id" = $1 and "userId" = $2 and "expiresAt" > now() for update`,
      [importId, userId],
    );
    const staging = result.rows[0];
    if (!staging) throw new PublicActionError("Import not found or expired.");
    const member = await client.query(
      `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u`,
      [staging.organizationId, userId],
    );
    if (!member.rowCount) throw new PublicActionError("Organization access denied.");
    if (staging.status === "committed") {
      const parent = await client.query(
        `select "id" from "designFile" where "id"=$1 and "organizationId"=$2 and "archivedAt" is null for share`,
        [staging.fileId, staging.organizationId],
      );
      if (!parent.rowCount) throw new PublicActionError("File not found or access denied.");
      await client.query("commit");
      return {
        fileId: staging.fileId!,
        revision: staging.committedRevision!,
        url: `/files/${staging.fileId}`,
        alreadyCommitted: true,
      };
    }
    if (staging.status !== "staging") throw new PublicActionError("Import is not active.");
    const incoming = assemble(staging.chunks);
    const layout = layoutReport(incoming);
    if (!layout.valid)
      throw new PublicActionError(
        "Resolve layout errors before committing. Run validate_import to inspect them.",
      );
    await verifyAssets(client, staging.organizationId, incoming);
    let fileId = staging.fileId;
    let revision = 1;
    let currentDocument: DesignDocument | null = null;
    if (fileId) {
      const current = await client.query<{
        revision: number | null;
        content: DesignDocument | null;
        legacyCount: number;
      }>(
        `select d."revision", d."content",
        ((select count(*) from "designFrame" where "fileId" = f."id") + (select count(*) from "designRectangle" where "fileId" = f."id"))::int as "legacyCount"
        from "designFile" f
        join "member" m on m."organizationId" = f."organizationId" and m."userId" = $3 and m."role" in ${EDIT_ROLES_SQL}
        join "user" u on u."id"=m."userId" and u."emailVerified"=true
        left join "designDocument" d on d."fileId" = f."id"
        where f."id" = $1 and f."organizationId" = $2 and f."archivedAt" is null for update of f for share of m,u`,
        [fileId, staging.organizationId, userId],
      );
      if (!current.rows[0]) throw new PublicActionError("File not found or access denied.");
      if ((current.rows[0].revision ?? 0) !== staging.expectedRevision)
        throw new PublicActionError(
          "File changed during import. Start a new import from the latest revision.",
        );
      revision = (current.rows[0].revision ?? 0) + 1;
      currentDocument = current.rows[0].content;
    } else {
      fileId = randomUUID();
      await client.query(
        `insert into "designFile" ("id", "organizationId", "name", "createdBy") values ($1,$2,$3,$4)`,
        [fileId, staging.organizationId, staging.name, userId],
      );
    }
    const document = mergeImport(currentDocument, incoming, importId, resolution);
    await verifyAssets(client, staging.organizationId, document);
    await client.query(
      `insert into "designDocument" ("fileId", "revision", "content") values ($1,$2,$3::jsonb)
      on conflict ("fileId") do update set "revision" = excluded."revision", "content" = excluded."content", "updatedAt" = now()`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query(
      `update "designImport" set "fileId" = $2, "status" = 'committed', "committedRevision" = $3, "chunks"='{}'::jsonb where "id" = $1`,
      [importId, fileId, revision],
    );
    await client.query("commit");
    await publishFileChanges(fileId);
    const key = incoming.source
      ? `${incoming.source.project}:${incoming.source.route}`
      : incoming.nodes[0]?.importKey;
    const publishedKey = resolution === "duplicate" && currentDocument ? `${key}#${importId}` : key;
    return {
      fileId,
      revision,
      url: `/files/${fileId}`,
      importedNodeCount: incoming.nodes.length,
      ...summarizeImportChunks(staging.chunks),
      nodeCount: document.nodes.length,
      nodeIds: document.nodes
        .filter((node) => node.parentId === null && node.importKey === publishedKey)
        .slice(0, 3)
        .map((node) => node.id),
      warnings: document.warnings,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function abortImport(userId: string, importId: string) {
  await requireDocumentSchema();
  const result = await db.query(
    `update "designImport" set "status" = 'aborted', "chunks"='{}'::jsonb where "id" = $1 and "userId" = $2 and "status" = 'staging'
    and exists (select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
        where m."organizationId" = "designImport"."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u)`,
    [importId, userId],
  );
  return { aborted: Boolean(result.rowCount) };
}

const allowedMime = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
export async function putAsset(
  userId: string,
  organizationId: string,
  mimeType: string,
  base64: string,
  signal?: AbortSignal,
) {
  await requireDocumentSchema();
  if (
    !allowedMime.has(mimeType) ||
    base64.length > 2_800_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new PublicActionError("Unsupported or oversized asset.");
  const body = Buffer.from(base64, "base64");
  if (body.length < 1 || body.length > 2_000_000)
    throw new PublicActionError("Asset must be 1 byte to 2 MB.");
  if (mimeType === "image/svg+xml") {
    const svg = body.toString("utf8");
    if (
      !/<svg\b/i.test(svg) ||
      /<!DOCTYPE|<!ENTITY|<\s*(script|foreignObject|iframe|object|embed)|\bon\w+\s*=|\b(?:href|src)\s*=\s*["'](?!#)|url\s*\(/i.test(
        svg,
      )
    ) {
      throw new PublicActionError("SVG contains unsafe content.");
    }
  }
  const signature = body.subarray(0, 16);
  if (mimeType === "image/png" && signature.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new PublicActionError("Invalid PNG.");
  if (mimeType === "image/jpeg" && signature.subarray(0, 2).toString("hex") !== "ffd8")
    throw new PublicActionError("Invalid JPEG.");
  if (
    mimeType === "image/webp" &&
    (signature.subarray(0, 4).toString() !== "RIFF" ||
      signature.subarray(8, 12).toString() !== "WEBP")
  )
    throw new PublicActionError("Invalid WebP.");
  const hash = createHash("sha256").update(body).digest("hex");
  return withOrganizationEditAuthority(userId, organizationId, async (client) => {
    const existing = await client.query<{ id: string }>(
      `select "id" from "designAsset" where "organizationId"=$1 and "sha256"=$2`,
      [organizationId, hash],
    );
    if (existing.rows[0]) {
      return { assetId: existing.rows[0].id, sha256: hash };
    }
    // Claims, quota admission and publication use one transaction, including inside agent tools.
    const { value: stored } = await inDatabaseScope(client, () =>
      storeDesignObject(organizationId, mimeType, body, "asset", signal),
    );
    const result = await client.query<{ id: string }>(
      `insert into "designAsset" ("id", "organizationId", "mimeType", "sha256", "body", "objectKey", "byteSize")
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict ("organizationId", "sha256") do update set "sha256"=excluded."sha256" returning "id"`,
      [
        randomUUID(),
        organizationId,
        mimeType,
        hash,
        stored.objectKey ? null : body,
        stored.objectKey,
        stored.byteSize,
      ],
    );
    return { assetId: result.rows[0].id, sha256: hash };
  });
}

export async function patchDocumentNode(
  userId: string,
  fileId: string,
  expectedRevision: number,
  nodeId: string,
  changes: DesignNodeChanges,
) {
  await requireDocumentSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query(
      `select f."id", f."organizationId" from "designFile" f
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("Document not found or access denied.");
    const result = await client.query<{ revision: number; content: DesignDocument }>(
      `select d."revision", d."content" from "designDocument" d
      join "designFile" f on f."id" = d."fileId" join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where d."fileId" = $1 and f."archivedAt" is null for update of d for share of m,u`,
      [fileId, userId],
    );
    const current = result.rows[0];
    if (!current) throw new PublicActionError("Document not found or access denied.");
    if (current.revision !== expectedRevision)
      throw new PublicActionError("Document changed. Refresh before editing.");
    const nodes = changedLayers(current.content, [nodeId], changes);
    const document = trackDocumentChanges(
      current.content,
      parseDesignDocument({
        ...current.content,
        nodes,
        editedNodeIds: [...new Set([...current.content.editedNodeIds, nodeId])],
      }),
    );
    await verifyAssets(client, access.rows[0].organizationId, document);
    const revision = current.revision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query("commit");
    await publishFileChanges(fileId);
    return { revision, node: document.nodes.find((node) => node.id === nodeId), document };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function addDocumentNode(
  userId: string,
  fileId: string,
  expectedRevision: number,
  parentId: string | null,
  type: "text" | "container",
  pageId = "page-1",
) {
  await requireDocumentSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query(
      `select f."id" from "designFile" f join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("File not found or access denied.");
    const result = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    const current = result.rows[0];
    if (!current || current.revision !== expectedRevision)
      throw new PublicActionError("Document changed. Refresh before editing.");
    const parent = current.content.nodes.find((node) => node.id === parentId);
    if (!(current.content.pages ?? [{ id: "page-1" }]).some((page) => page.id === pageId))
      throw new PublicActionError("Page not found.");
    if (parent && (parent.pageId ?? "page-1") !== pageId)
      throw new PublicActionError("Select a layer on this page.");
    if (
      parentId !== null &&
      (!parent || !["artboard", "container"].includes(parent.type) || parent.locked)
    )
      throw new PublicActionError("Select an unlocked frame or container.");
    const id = randomUUID();
    const node: DesignNode = {
      id,
      parentId,
      pageId,
      name: type === "text" ? "Text" : "Container",
      type,
      box: parent
        ? {
            x: Math.min(20, parent.box.width - 1),
            y: Math.min(20, parent.box.height - 1),
            width: Math.max(1, Math.min(200, parent.box.width - 20)),
            height: type === "text" ? 48 : 120,
          }
        : { x: 120, y: 120, width: 200, height: type === "text" ? 48 : 120 },
      style:
        type === "text" ? { fontSize: 16, fontWeight: 400, color: "#1e1e1e" } : { fill: "#ffffff" },
      text: type === "text" ? "Text" : undefined,
      visible: true,
      locked: false,
      layout: "absolute",
    };
    const document = trackDocumentChanges(current.content, {
      ...current.content,
      nodes: [...current.content.nodes, node],
    });
    const revision = current.revision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query("commit");
    await publishFileChanges(fileId);
    return { revision, node, document };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function drawDocumentNode(
  userId: string,
  fileId: string,
  expectedRevision: number,
  nodeId: string,
  type: "artboard" | "container" | "text",
  parentId: string | null,
  box: DesignNode["box"],
  pageId = "page-1",
) {
  await requireDocumentSchema();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nodeId))
    throw new PublicActionError("Invalid layer ID.");
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query(
      `select f."id" from "designFile" f join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("File not found or access denied.");
    const result = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    const current = result.rows[0];
    if (!current || current.revision !== expectedRevision)
      throw new PublicActionError("Document changed. Refresh before editing.");
    const parent = current.content.nodes.find((node) => node.id === parentId);
    if (!(current.content.pages ?? [{ id: "page-1" }]).some((page) => page.id === pageId))
      throw new PublicActionError("Page not found.");
    if (parent && (parent.pageId ?? "page-1") !== pageId)
      throw new PublicActionError("Select a layer on this page.");
    if (
      type !== "artboard" &&
      parentId !== null &&
      (!parent || !["artboard", "container"].includes(parent.type) || parent.locked)
    )
      throw new PublicActionError("Place layers inside an unlocked frame or container.");
    if (type === "artboard" && parentId !== null)
      throw new PublicActionError("Frames must be placed on the canvas.");
    const node = { ...buildDrawnNode(nodeId, type, parentId, box), pageId };
    const document = trackDocumentChanges(current.content, {
      ...current.content,
      nodes: [...current.content.nodes, node],
    });
    const revision = current.revision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query("commit");
    await publishFileChanges(fileId);
    return { revision, node, document };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteDocumentNode(
  userId: string,
  fileId: string,
  expectedRevision: number,
  nodeId: string,
) {
  await requireDocumentSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query(
      `select f."id" from "designFile" f join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("File not found or access denied.");
    const result = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    const current = result.rows[0];
    if (!current || current.revision !== expectedRevision)
      throw new PublicActionError("Document changed. Refresh before editing.");
    const selected = current.content.nodes.find((node) => node.id === nodeId);
    if (!selected || selected.locked) throw new PublicActionError("Node not found or locked.");
    const removed = new Set([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of current.content.nodes)
        if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
          removed.add(node.id);
          changed = true;
        }
    }
    const tombstones = current.content.nodes
      .filter((node) => removed.has(node.id) && node.importKey && node.sourceKey)
      .map((node) => ({ importKey: node.importKey!, sourceKey: node.sourceKey! }));
    const deletedSourceKeys = [...(current.content.deletedSourceKeys ?? []), ...tombstones].filter(
      (item, index, all) =>
        all.findIndex(
          (other) => other.importKey === item.importKey && other.sourceKey === item.sourceKey,
        ) === index,
    );
    const document = trackDocumentChanges(current.content, {
      ...current.content,
      nodes: removeComponentReferences(current.content.nodes, removed),
      editedNodeIds: current.content.editedNodeIds.filter((id) => !removed.has(id)),
      deletedSourceKeys,
    });
    const revision = current.revision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query("commit");
    await publishFileChanges(fileId);
    return {
      revision,
      removed: [...removed],
      deletedSourceKeys: document.deletedSourceKeys,
      document,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function duplicateDocumentNode(
  userId: string,
  fileId: string,
  expectedRevision: number,
  nodeId: string,
) {
  await requireDocumentSchema();
  const client = await db.connect();
  try {
    await client.query("begin");
    const access = await client.query(
      `select f."id" from "designFile" f join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${EDIT_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id" = $1 and f."archivedAt" is null for update of f for share of m,u`,
      [fileId, userId],
    );
    if (!access.rowCount) throw new PublicActionError("File not found or access denied.");
    const result = await client.query<{ revision: number; content: DesignDocument }>(
      `select "revision", "content" from "designDocument" where "fileId" = $1 for update`,
      [fileId],
    );
    const current = result.rows[0];
    if (!current || current.revision !== expectedRevision)
      throw new PublicActionError("Document changed. Refresh before editing.");
    const copy = duplicateNodeTree(current.content, nodeId);
    const document = trackDocumentChanges(current.content, {
      ...current.content,
      nodes: [...current.content.nodes, ...copy.nodes],
    });
    const revision = current.revision + 1;
    await client.query(
      `update "designDocument" set "revision" = $2, "content" = $3::jsonb, "updatedAt" = now() where "fileId" = $1`,
      [fileId, revision, JSON.stringify(document)],
    );
    await client.query(`update "designFile" set "updatedAt" = now() where "id" = $1`, [fileId]);
    await client.query("commit");
    await publishFileChanges(fileId);
    return { revision, ...copy, document };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Batch MIME metadata under the same current organization membership as asset reads. */
async function withAssetMimeTypes<T extends { content: DesignDocument } | null>(
  userId: string,
  snapshot: T,
): Promise<T> {
  if (!snapshot) return snapshot;
  const ids = documentAssetIds(snapshot.content);
  if (!ids.length) return snapshot;
  const result = await db.query<{ id: string; mimeType: string }>(
    `select a."id", a."mimeType" from "designAsset" a
     join "member" m on m."organizationId"=a."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where a."id"=any($1::text[])`,
    [ids, userId],
  );
  return {
    ...snapshot,
    content: {
      ...snapshot.content,
      assetMimeTypes: Object.fromEntries(result.rows.map((asset) => [asset.id, asset.mimeType])),
    },
  };
}
export async function getDocument(userId: string, fileId: string) {
  return withAssetMimeTypes(userId, await readDocument(userId, fileId));
}
export async function getArchivedEditorDocument(userId: string, fileId: string) {
  return withAssetMimeTypes(userId, await readArchivedEditorDocument(userId, fileId));
}
export async function ensureEditorDocument(userId: string, fileId: string) {
  return withAssetMimeTypes(userId, await readEditorDocument(userId, fileId));
}
