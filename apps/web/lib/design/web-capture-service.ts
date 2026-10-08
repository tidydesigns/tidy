import { randomUUID } from "node:crypto";
import { parseDesignDocument } from "@bella/design/document";
import { webImportSchema } from "@bella/design/web-capture";
import { getDesignFile } from "@/lib/design/service";
import {
  abortImport,
  commitImport,
  createImport,
  putAsset,
  putImportChunk,
  validateImport,
} from "@/lib/design/document-service";
import type { ActivityObserver } from "@/lib/realtime/agent-activity";
import type { ImportCommitResult } from "./document-service";

const importServices = {
  getDesignFile,
  abortImport,
  commitImport,
  createImport,
  putAsset,
  putImportChunk,
  validateImport,
};

export async function importWebCapture(
  userId: string,
  input: unknown,
  services = importServices,
  observe?: ActivityObserver,
): Promise<ImportCommitResult> {
  const { userId: expectedUserId, organizationId, fileId, capture } = webImportSchema.parse(input);
  if (expectedUserId !== userId)
    throw new Error("Your Tidy account changed. Choose the destination again.");
  if (fileId) {
    const file = await services.getDesignFile(userId, fileId);
    if (!file || file.organizationId !== organizationId)
      throw new Error("File not found or access denied.");
  }
  const staging = await services.createImport(userId, organizationId, capture.title, fileId);
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
    for (const asset of capture.assets) {
      const uploaded = await services.putAsset(
        userId,
        organizationId,
        asset.mimeType,
        asset.base64,
      );
      assetIds.set(asset.id, uploaded.assetId);
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
    // Bound chunks by bytes as well as node count, including large text layers.
    let chunk: typeof nodes = [],
      chunkBytes = 0,
      index = 0;
    let acceptedNodes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      await services.putImportChunk(
        userId,
        staging.importId,
        String(index++).padStart(4, "0"),
        chunk,
        source,
        index === 1 ? document.warnings : [],
        document.tokens,
        document.designTokens,
      );
      acceptedNodes += chunk.length;
      await observe?.("receiving", {
        ...details,
        nodeCount: acceptedNodes,
        assetCount: new Set(assetIds.values()).size,
      });
      chunk = [];
      chunkBytes = 0;
    };
    for (const node of nodes) {
      const bytes = JSON.stringify(node).length;
      if (chunk.length === 250 || chunkBytes + bytes > 300_000) await flush();
      chunk.push(node);
      chunkBytes += bytes;
    }
    await flush();
    await observe?.("validating");
    await services.validateImport(userId, staging.importId);
    await observe?.("publishing");
    return {
      ...(await services.commitImport(userId, staging.importId, "duplicate")),
      sourceProject: details.sourceProject,
      sourceRoute: details.sourceRoute,
    };
  } catch (error) {
    await services.abortImport(userId, staging.importId).catch(() => undefined);
    throw error;
  }
}
