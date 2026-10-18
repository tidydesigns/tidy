import type { DocumentPatch } from "../design/document-patch";
export type RevisionPatch = { baseRevision: number; revision: number; patch: DocumentPatch };
