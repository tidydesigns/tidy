import { applyDocumentPatch, type DocumentPatch } from "./document-patch";
import type { RoomSnapshot } from "./room-edit-queue";
import type { RevisionPatch } from "./changes";
export type RevisionChanges = { baseRevision: number; revision: number; patches: RevisionPatch[] };

export function applyRevisionChanges(before: RoomSnapshot, changes: RevisionChanges): RoomSnapshot {
  if (changes.revision < before.revision) return before;
  if (changes.baseRevision !== before.revision)
    throw new Error("File synchronization requires a snapshot.");
  let revision = before.revision;
  const patch: DocumentPatch = [];
  for (const change of changes.patches) {
    if (change.baseRevision !== revision || change.revision !== revision + 1)
      throw new Error("File change history has a gap.");
    revision = change.revision;
    patch.push(...change.patch);
  }
  if (revision !== changes.revision) throw new Error("File change history is incomplete.");
  return patch.length ? { revision, content: applyDocumentPatch(before.content, patch) } : before;
}
