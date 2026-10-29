/** Build once per listing update; expanding a folder only reads its bucket. */
export function indexFolderFiles<T extends { folderId: string | null; updatedAt: string }>(
  files: readonly T[],
  newestFirst: boolean,
): Map<string | null, T[]> {
  const folders = new Map<string | null, T[]>();
  for (const file of files) {
    const siblings = folders.get(file.folderId);
    if (siblings) siblings.push(file);
    else folders.set(file.folderId, [file]);
  }
  for (const siblings of folders.values()) {
    siblings.sort(
      (a, b) => (newestFirst ? -1 : 1) * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)),
    );
  }
  return folders;
}
