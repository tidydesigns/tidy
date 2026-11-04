import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

/** Reject special files and symlinks; bound reads even when a file grows after stat. */
export async function readLocalFile(
  path: string,
  limit = 16 * 1024 * 1024,
  verifyOpened?: (info: Stats, handle: FileHandle) => Promise<void>,
) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Local files must be regular files, not symbolic links.");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Local files must be regular files.");
    if (info.size > limit) throw new Error("The local project file is too large.");
    await verifyOpened?.(info, file);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error("The local project file is too large.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (verifyOpened) await verifyOpened(await file.stat(), file);
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}
