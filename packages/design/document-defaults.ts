import type { DesignDocument } from "./document";

export const DEFAULT_PAGE_ID = "page-1";
export function blankDesignDocument(): DesignDocument {
  return {
    schemaVersion: 1,
    legacyConverted: true,
    pages: [{ id: DEFAULT_PAGE_ID, name: "Page 1" }],
    nodes: [],
    tokens: {},
    warnings: [],
    editedNodeIds: [],
    deletedSourceKeys: [],
  };
}
