import {
  isWebCaptureImportKey,
  parseDesignDocument,
  type DocumentParser,
  type DesignDocument,
} from "./document";
import { reconcileComponentStructure } from "./component-structure";
import { equalJsonValues } from "./json-value";

/** Preserve import ownership through every browser operation, including bulk edits. */
export function trackDocumentChanges(
  before: DesignDocument,
  after: DesignDocument,
  parse: DocumentParser = parseDesignDocument,
): DesignDocument {
  after = { ...after, nodes: reconcileComponentStructure(before.nodes, after.nodes) };
  const nextNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const edited = new Set(after.editedNodeIds);
  const deleted = [...after.deletedSourceKeys];
  for (const node of before.nodes) {
    const next = nextNodes.get(node.id);
    if (node.importKey && next && !equalJsonValues(node, next)) edited.add(node.id);
    if (!next && node.importKey && node.sourceKey && !isWebCaptureImportKey(node.importKey))
      deleted.push({ importKey: node.importKey, sourceKey: node.sourceKey });
  }
  return parse({
    ...after,
    editedNodeIds: [...edited].filter((id) => nextNodes.has(id)),
    deletedSourceKeys: [
      ...new Map(deleted.map((item) => [`${item.importKey}:${item.sourceKey}`, item])).values(),
    ],
  });
}
