import { createHash, randomUUID } from "node:crypto";
import { parseDesignDocument } from "@tidy/design/document";
import { webImportSchema } from "@tidy/design/web-capture";
import { nodeAssetIds } from "@tidy/design/document";
import { captureReceipt, CaptureInProgressError } from "@/lib/extension/receipts";
import {
  abortImport,
  commitImport,
  createImport,
  putAsset,
  putImportDocument,
} from "@/lib/design/document-service";
import type { ActivityObserver } from "@/lib/realtime/agent-activity";
import type { ImportCommitResult } from "./document-service";
import { PublicActionError } from "@/lib/security/public-error";

const importServices = {
  captureReceipt,
  abortImport,
  commitImport,
  createImport,
  putAsset,
  putImportDocument,
};

export async function importWebCapture(
  userId: string,
  input: unknown,
  services = importServices,
  observe?: ActivityObserver,
  request?: { id: string; hash: string; createdAt: number },
): Promise<ImportCommitResult> {
  const { userId: expectedUserId, organizationId, fileId, capture } = webImportSchema.parse(input);
  if (expectedUserId !== userId)
    throw new PublicActionError("Your Tidy account changed. Choose the destination again.");
  // createImport checks the file/workspace relationship and current editing authority.
  const staging = await services.createImport(
    userId,
    organizationId,
    capture.title,
    fileId,
    request,
  );
  if (staging.alreadyCreated && request) {
    const receipt = await services.captureReceipt(userId, request.id);
    if (receipt?.state === "done") return receipt.result;
    if (receipt?.state === "pending") throw new CaptureInProgressError();
    throw new PublicActionError("This capture failed or expired. Start a new capture.");
  }
  try {
    const sourceUrl = new URL(capture.url);
    const details = {
      sourceProject: sourceUrl.hostname.slice(0, 80),
      sourceRoute: sourceUrl.pathname.slice(0, 160),
      nodeCount: 0,
      assetCount: 0,
    };
    await observe?.("receiving", details);
    const assetIds = new Map<string, string>();
    const referenced = new Set(capture.document.nodes.flatMap(nodeAssetIds));
    const uploadedByHash = new Map<string, string>();
    for (const asset of capture.assets) {
      if (!referenced.has(asset.id)) continue;
      const hash = createHash("sha256").update(asset.mimeType).update(asset.base64).digest("hex");
      const previous = uploadedByHash.get(hash);
      if (previous) {
        assetIds.set(asset.id, previous);
        continue;
      }
      const uploaded = await services.putAsset(
        userId,
        organizationId,
        asset.mimeType,
        asset.base64,
      );
      assetIds.set(asset.id, uploaded.assetId);
      uploadedByHash.set(hash, uploaded.assetId);
      await observe?.("receiving", { ...details, assetCount: new Set(assetIds.values()).size });
    }
    // Every copy has its own source key. Copies never replace earlier captures or user edits.
    const source = {
      project: sourceUrl.hostname.slice(0, 120),
      route: `web-capture/${randomUUID()}`,
    };
    const ids = new Map(capture.document.nodes.map((node) => [node.id, randomUUID()]));
    const nodes = capture.document.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId ? ids.get(node.parentId)! : null,
      pageId: "page-1",
      assetId: node.assetId ? assetIds.get(node.assetId) : undefined,
      style: {
        ...node.style,
        paints: node.style.paints?.map((paint) =>
          paint.type === "image"
            ? { ...paint, assetId: paint.assetId ? assetIds.get(paint.assetId) : undefined }
            : paint,
        ),
      },
      sourceKey: node.id,
      importKey: undefined,
      sourcePath: undefined,
      instanceOf: undefined,
      componentSourceId: undefined,
      linkTo: undefined,
    }));
    const document = parseDesignDocument({
      schemaVersion: 1,
      legacyConverted: true,
      nodes,
      source,
      tokens: capture.document.tokens,
      designTokens: capture.document.designTokens,
      warnings: capture.document.warnings.map(({ message }) => ({ message })),
    });
    // This transport already has a complete validated document. Stage once instead
    // of rewriting and returning an ever-growing JSONB row for every 250 layers.
    await services.putImportDocument(userId, staging.importId, document, { preservePages: false });
    await observe?.("receiving", {
      ...details,
      nodeCount: nodes.length,
      assetCount: uploadedByHash.size,
    });
    await observe?.("validating");
    // commitImport validates layout, assets and revision inside the publication transaction.
    await observe?.("publishing");
    const committed = await services.commitImport(userId, staging.importId, "duplicate");
    return {
      ...committed,
      // The popup describes this copy; earlier imports retain their notes in the file.
      warnings: document.warnings,
      sourceProject: details.sourceProject,
      sourceRoute: details.sourceRoute,
    };
  } catch (error) {
    await services.abortImport(userId, staging.importId).catch(() => undefined);
    throw error;
  }
}
