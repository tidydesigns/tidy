import { parseDesignDocument, type DesignDocument } from "@tidy/design/document";
import {
  abortImport,
  createImport,
  putImportDocument,
  validateImport,
  commitImport,
} from "./document-service";

export async function publishFigmaImport(
  userId: string,
  organizationId: string,
  name: string,
  input: DesignDocument,
  folderId?: string | null,
) {
  const document = parseDesignDocument(input);
  const staging = await createImport(userId, organizationId, name);
  try {
    await putImportDocument(userId, staging.importId, document, {
      tooLargeMessage: "Figma document is too large. Select fewer pages.",
    });
    await validateImport(userId, staging.importId);
    return await commitImport(userId, staging.importId, "duplicate", folderId);
  } catch (cause) {
    await abortImport(userId, staging.importId).catch(() => undefined);
    throw cause;
  }
}
