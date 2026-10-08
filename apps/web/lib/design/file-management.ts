import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { planLimitMessage } from "@/lib/billing/plans";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { FILE_MANAGEMENT_LIMITS as limits } from "@/lib/security/resource-limits";
import { OrganizationAccessError, withOrganizationEditAuthority } from "./organization-authority";
import { FileManagementBudgetUnavailableError } from "./file-management-budget";
import {
  FileManagementError,
  validId,
  discoverFileManagement,
  folderAuthority,
} from "./file-management-authority";
import { publishFileChanges } from "@/lib/realtime/server";
import { documentSchemaReady } from "./document-service";
import { blankDesignDocument, parseDesignDocument, documentAssetIds } from "./document";

const fileAdjectives = ["Bright", "Quiet", "Fresh", "Golden", "Little", "Open", "Soft", "Sunny"];
const fileNouns = [
  "canvas",
  "dolphin",
  "garden",
  "horizon",
  "studio",
  "sparrow",
  "meadow",
  "orbit",
];
function randomDesignFileName() {
  return `${fileAdjectives[Math.floor(Math.random() * fileAdjectives.length)]} ${fileNouns[Math.floor(Math.random() * fileNouns.length)]}`;
}

function publicError(error: unknown, fallback: string) {
  if (
    error instanceof FileManagementError ||
    error instanceof OrganizationAccessError ||
    error instanceof MutationBudgetError ||
    error instanceof FileManagementBudgetUnavailableError
  )
    return error.message;
  return planLimitMessage(error) ?? fallback;
}

type FileManagementResult = { id: string; error?: never } | { id?: never; error: string };

type SourceFile = { id: string; name: string; folderId: string | null; archivedAt: Date | null };

/** Reject the entire folder before reading documents or creating a destination. */
async function copyAdmission(
  client: PoolClient,
  organizationId: string,
  files: SourceFile[],
  documents: boolean,
) {
  const plan = await client.query<{ tier: string; allowance: number | null }>(
    `select p."id" as tier,p."fileLimit" as allowance from "billingPlan" p where p."id"="organizationPlan"($1)`,
    [organizationId],
  );
  if (plan.rows.length !== 1) throw new Error("Missing file plan configuration.");
  const allowance = plan.rows[0]!.allowance;
  if (allowance !== null && files.length) {
    const existing = await client.query<{ count: number }>(
      `select count(*)::int as count from (select 1 from "designFile" where "organizationId"=$1 limit $2) f`,
      [organizationId, allowance + 1],
    );
    if (existing.rows[0]!.count + files.length > allowance)
      throw new FileManagementError(
        "This copy exceeds your file allowance. Remove files or upgrade your plan.",
      );
  }
  let bytes = 0,
    nodes = 0,
    shapes = 0;
  for (const file of files) {
    if (documents) {
      const metadata = await client.query<{ bytes: number; nodes: number }>(
        `select octet_length("content"::text)::float8 as bytes,jsonb_array_length("content"->'nodes')::float8 as nodes
         from "designDocument" where "fileId"=$1 for share`,
        [file.id],
      );
      if (metadata.rows[0]) {
        const value = metadata.rows[0];
        if (
          !Number.isSafeInteger(value.bytes) ||
          !Number.isSafeInteger(value.nodes) ||
          value.bytes < 0 ||
          value.nodes < 0 ||
          value.bytes > limits.documentBytesPerFile
        )
          throw new FileManagementError("A file is too large to duplicate safely.");
        bytes += value.bytes;
        nodes += value.nodes;
      }
    }
    for (const table of ["designFrame", "designRectangle"] as const) {
      const rows = await client.query(
        `select "id" from "${table}" where "fileId"=$1 order by "id" limit $2 for share`,
        [file.id, limits.legacyShapesPerCopy - shapes + 1],
      );
      shapes += rows.rows.length;
      if (shapes > limits.legacyShapesPerCopy)
        throw new FileManagementError(
          "This copy has too many legacy shapes. Duplicate fewer files.",
        );
    }
    if (bytes > limits.documentBytesPerCopy || nodes > limits.nodesPerCopy)
      throw new FileManagementError("This copy is too large. Duplicate fewer files.");
  }
}

async function copyFile(
  client: PoolClient,
  organizationId: string,
  source: SourceFile,
  target: string,
  folderId: string | null,
  name: string,
  actor: string,
  archivedAt: Date | null,
  documents: boolean,
) {
  await client.query(
    `insert into "designFile" ("id","organizationId","name","createdBy","folderId","archivedAt") values ($1,$2,$3,$4,$5,$6)`,
    [target, organizationId, name, actor, folderId, archivedAt],
  );
  for (const table of ["designFrame", "designRectangle"] as const) {
    await client.query(
      `insert into "${table}" ("id","fileId","x","y","width","height")
       select gen_random_uuid()::text,$2,"x","y","width","height" from "${table}" where "fileId"=$1 order by "createdAt","id"`,
      [source.id, target],
    );
  }
  if (documents) {
    const result = await client.query<{ content: unknown }>(
      `select "content" from "designDocument" where "fileId"=$1`,
      [source.id],
    );
    if (result.rows[0]) {
      // Validate every supported image reference, including component variants.
      const document = parseDesignDocument(result.rows[0].content);
      const ids = documentAssetIds(document);
      if (ids.length) {
        const assets = await client.query(
          `select "id" from "designAsset" where "organizationId"=$1 and "id"=any($2::text[]) for share`,
          [organizationId, ids],
        );
        if (assets.rows.length !== ids.length)
          throw new FileManagementError("One or more images are missing or inaccessible.");
      }
      // Preserve the original document exactly; the new file starts at revision one.
      await client.query(
        `insert into "designDocument" ("fileId","revision","content") select $2,1,"content" from "designDocument" where "fileId"=$1`,
        [source.id, target],
      );
    }
  }
}

export async function createBrowserFileForUser(
  userId: string,
  organizationId: string,
  folderId: string | null,
): Promise<FileManagementResult> {
  try {
    if (folderId !== null && !validId(folderId))
      throw new FileManagementError("File or folder not found or access denied.");
    const bound = await discoverFileManagement(userId, organizationId, "organization");
    const documents = await documentSchemaReady();
    return await withOrganizationEditAuthority(userId, bound, async (client) => {
      if (folderId !== null) await folderAuthority(client, bound, folderId);
      const id = randomUUID();
      await client.query(
        `insert into "designFile" ("id","organizationId","name","createdBy","folderId") values ($1,$2,$3,$4,$5)`,
        [id, bound, randomDesignFileName(), userId, folderId],
      );
      if (documents)
        await client.query(
          `insert into "designDocument" ("fileId","revision","content") values ($1,1,$2::jsonb)`,
          [id, JSON.stringify(blankDesignDocument())],
        );
      return { id };
    });
  } catch (error) {
    return { error: publicError(error, "Could not create the file. Please try again.") };
  }
}

export async function duplicateFolderForUser(
  userId: string,
  folderId: string,
): Promise<FileManagementResult> {
  try {
    const bound = await discoverFileManagement(userId, folderId, "folder");
    const documents = await documentSchemaReady();
    return await withOrganizationEditAuthority(userId, bound, async (client) => {
      const source = await folderAuthority(client, bound, folderId);
      const files = await client.query<SourceFile>(
        `select "id","name","folderId","archivedAt" from "designFile" where "folderId"=$1 and "organizationId"=$2
         order by "id" limit $3 for share`,
        [folderId, bound, limits.filesPerCopy + 1],
      );
      if (files.rows.length > limits.filesPerCopy)
        throw new FileManagementError(
          "This folder has too many files to duplicate at once. Duplicate files individually.",
        );
      await copyAdmission(client, bound, files.rows, documents);
      const id = randomUUID();
      await client.query(
        `insert into "designFolder" ("id","organizationId","name","createdBy") values ($1,$2,$3,$4)`,
        [id, bound, `${source.name.slice(0, 115)} copy`, userId],
      );
      for (const file of files.rows)
        await copyFile(
          client,
          bound,
          file,
          randomUUID(),
          id,
          file.name,
          userId,
          file.archivedAt,
          documents,
        );
      return { id };
    });
  } catch (error) {
    return { error: publicError(error, "Could not duplicate the folder.") };
  }
}

export async function duplicateFileForUser(
  userId: string,
  fileId: string,
): Promise<FileManagementResult> {
  try {
    const bound = await discoverFileManagement(userId, fileId, "file");
    const documents = await documentSchemaReady();
    return await withOrganizationEditAuthority(userId, bound, async (client) => {
      const result = await client.query<SourceFile>(
        `select "id","name","folderId","archivedAt" from "designFile" where "id"=$1 and "organizationId"=$2 for share`,
        [fileId, bound],
      );
      if (result.rows.length !== 1)
        throw new FileManagementError("File or folder not found or access denied.");
      const source = result.rows[0]!;
      if (source.folderId !== null) await folderAuthority(client, bound, source.folderId);
      await copyAdmission(client, bound, [source], documents);
      const id = randomUUID();
      await copyFile(
        client,
        bound,
        source,
        id,
        source.folderId,
        `${source.name.slice(0, 115)} copy`,
        userId,
        null,
        documents,
      );
      return { id };
    });
  } catch (error) {
    return { error: publicError(error, "Could not duplicate the file.") };
  }
}

export async function archiveFileForUser(userId: string, fileId: string, archived: boolean) {
  try {
    if (typeof archived !== "boolean")
      throw new FileManagementError("File or folder not found or access denied.");
    const bound = await discoverFileManagement(userId, fileId, "file");
    await withOrganizationEditAuthority(userId, bound, async (client) => {
      const result = await client.query(
        `update "designFile" set "archivedAt"=case when $2::boolean then now() else null end,"updatedAt"=now()
         where "id"=$1 and "organizationId"=$3 returning "id"`,
        [fileId, archived, bound],
      );
      if (result.rows.length !== 1)
        throw new FileManagementError("File or folder not found or access denied.");
    });
    await publishFileChanges(fileId);
    return {};
  } catch (error) {
    return {
      error: publicError(
        error,
        archived ? "Could not archive the file." : "Could not restore the file.",
      ),
    };
  }
}
