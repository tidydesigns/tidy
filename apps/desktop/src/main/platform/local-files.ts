import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Reject special files and symlinks; bound reads even when a file grows after stat. */
export async function readLocalFile(path: string, limit = 16 * 1024 * 1024) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Local files must be regular files, not symbolic links.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error("The local project file is too large.");
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
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}
