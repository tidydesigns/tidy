import type { DesignDocument, DesignNode } from "../design/document";
import { documentFontReferences, type FontReference } from "../design/fonts/recovery";
import { equalJsonValues } from "../design/json-value";

export function createFontReferenceSelector() {
  let previous: DesignNode[] | undefined;
  let references: FontReference[] = [];
  return (document: DesignDocument) => {
    const nodes = document.nodes.filter(
      (node) => node.type === "text" || node.variants || node.componentSourceId,
    );
    const before = previous;
    if (
      before &&
      before.length === nodes.length &&
      nodes.every(
        (node, index) =>
          node === before[index] ||
          equalJsonValues(before[index], { ...node, box: before[index].box }),
      )
    )
      return references;
    previous = nodes;
    references = documentFontReferences(document);
    return references;
  };
}
