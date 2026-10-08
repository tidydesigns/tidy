import { db } from "@/lib/db";
import { buildLoginDocument } from "@/lib/design/examples/login";
import {
  commitImport,
  createImport,
  getDocument,
  putImportChunk,
  validateImport,
} from "@/lib/design/document-service";

const userId = process.env.BELLA_IMPORT_USER_ID;
const organizationId = process.env.BELLA_IMPORT_ORG_ID;
const fileId = process.env.BELLA_IMPORT_FILE_ID;
if (process.env.BELLA_APPROVED_IMPORT !== "login" || !userId || !organizationId || !fileId) {
  throw new Error(
    "Set BELLA_APPROVED_IMPORT=login and the exact user, organization, and file IDs for an approved import.",
  );
}

try {
  const file = await db.query<{ organizationId: string; createdBy: string }>(
    `select "organizationId", "createdBy" from "designFile" where "id" = $1 and "archivedAt" is null`,
    [fileId],
  );
  if (file.rows[0]?.organizationId !== organizationId || file.rows[0]?.createdBy !== userId) {
    throw new Error("Target file, organization, and creator do not match.");
  }
  const document = buildLoginDocument();
  const staging = await createImport(userId, organizationId, "Login · codebase import", fileId);
  await putImportChunk(
    userId,
    staging.importId,
    "000",
    document.nodes,
    document.source,
    document.warnings,
  );
  const checked = await validateImport(userId, staging.importId);
  const committed = await commitImport(userId, staging.importId);
  const readback = await getDocument(userId, fileId);
  if (
    committed.fileId !== fileId ||
    checked.nodeCount !== document.nodes.length ||
    readback?.content.nodes.length !== document.nodes.length
  ) {
    throw new Error("Imported file failed readback verification.");
  }
  console.log(
    JSON.stringify(
      {
        fileId,
        revision: readback.revision,
        artboards: readback.content.nodes
          .filter((node) => node.type === "artboard")
          .map((node) => node.name),
        nodeCount: readback.content.nodes.length,
        url: committed.url,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
