import { errorMessage } from "@tidy/ui/errors";
import { ZodError } from "zod";
import { ComponentStructureError } from "./component-structure-error";
import type { DesignDocument } from "./document";
import { isLayerLocked } from "./edit-document";
import { nodeIndex } from "./node-index";

export type EditorErrorNotice = {
  message: string;
  detach?: { instanceId: string; componentId: string };
};

export function editorErrorNotice(error: unknown, fallback: string): EditorErrorNotice {
  return {
    message: editorErrorMessage(error, fallback),
    ...(error instanceof ComponentStructureError
      ? { detach: { instanceId: error.instanceId, componentId: error.componentId } }
      : {}),
  };
}

/** A stale warning must never detach a different, swapped, or locked instance. */
export function editorErrorInstance(document: DesignDocument, notice: EditorErrorNotice) {
  const target = notice.detach;
  if (!target) return undefined;
  const node = nodeIndex(document.nodes).get(target.instanceId);
  return node &&
    node.instanceOf === target.componentId &&
    node.componentSourceId === target.componentId &&
    !isLayerLocked(document.nodes, node.id)
    ? node
    : undefined;
}

/** Keep validation payloads out of the canvas while preserving useful edit conflicts. */
export function editorErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error instanceof ZodError || error.name === "ZodError")
    return fallback;
  const message = error.message.trim();
  if (
    /^Detach the instance before (?:adding or reparenting|deleting or moving|reparenting|reordering) its children\.$/.test(
      message,
    )
  )
    return "This layer belongs to a component instance. Use Detach instance in the Component section before changing its layers.";
  // Server errors can carry a serialized Zod issue array rather than its class.
  if (message.startsWith("[")) {
    if (message.length > 100_000) return fallback;
    try {
      const issues: unknown = JSON.parse(message);
      if (
        Array.isArray(issues) &&
        issues.some(
          (issue) =>
            issue &&
            typeof issue === "object" &&
            "code" in issue &&
            "path" in issue &&
            "message" in issue,
        )
      )
        return fallback;
    } catch {
      // Non-JSON errors use the reviewed mapping below.
    }
  }
  const reviewed = new Set([
    "This layer is locked.",
    "The file changed elsewhere. Retry after reviewing the latest file.",
    "You do not have permission to edit this file.",
  ]);
  return reviewed.has(message) ? message : errorMessage(error, fallback);
}
