export type FileMove = {
  operationId: string;
  folderId: string | null;
  updatedAt: string;
  complete?: boolean;
};

/** Pending moves project into the destination immediately. Once acknowledged,
 * newer server metadata wins, including another person's subsequent move. */
export function projectFileMove<T extends { folderId: string | null; updatedAt: string }>(
  file: T,
  move?: FileMove,
): T {
  if (
    !move ||
    file.folderId === move.folderId ||
    (move.complete && file.updatedAt !== move.updatedAt)
  )
    return file;
  return { ...file, folderId: move.folderId };
}

/** A late failure may only roll back its own operation. */
export function settleFileMove(
  moves: Record<string, FileMove>,
  fileId: string,
  operationId: string,
  success: boolean,
) {
  const move = moves[fileId];
  if (!move || move.operationId !== operationId) return moves;
  if (success) return { ...moves, [fileId]: { ...move, complete: true } };
  const next = { ...moves };
  delete next[fileId];
  return next;
}
