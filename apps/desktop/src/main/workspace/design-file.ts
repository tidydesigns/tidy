import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { parseDesignDocument } from "@tidy/design/document";
import { readLocalFile } from "../platform/local-files";
import type { LocalDesign } from "../../shared/contracts/desktop";

export type ParsedDesignFile = Omit<LocalDesign, "assets"> & { stamp: string; bytes: number };
export type DesignFileSummary = Omit<ParsedDesignFile, "document" | "bytes">;
export const summarizeDesignFile = (file: ParsedDesignFile): DesignFileSummary => ({
  id: file.id,
  name: file.name,
  folderId: file.folderId,
  nodeCount: file.nodeCount,
  path: file.path,
  updatedAt: file.updatedAt,
  version: file.version,
  stamp: file.stamp,
});
export const designFileStamp = (info: BigIntStats) =>
  [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");

/** Worker-owned snapshots bridge metadata scans and canvas opens without a second
 * decode. Only postMessage copies leave the worker; callers must not mutate these. */
export class DesignFileCache {
  private files = new Map<string, ParsedDesignFile>();

  async read(path: string): Promise<ParsedDesignFile> {
    try {
      // Recheck file identity on every hit, including equal-length edits with
      // restored mtimes. Never follow a replacement symlink into cached content.
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Local files must be regular files, not symbolic links.");
      const cached = this.files.get(path);
      const file = cached?.stamp === designFileStamp(info) ? cached : await readDesignFile(path);
      this.files.delete(path);
      this.files.set(path, file);
      let bytes = 0;
      let nodes = 0;
      for (const value of this.files.values()) {
        bytes += value.bytes;
        nodes += value.document.nodes.length;
      }
      // Small shared cache, bounded independently of the main-process open files.
      while (this.files.size > 4 || bytes > 16 * 1024 * 1024 || nodes > 20_000) {
        const oldest = this.files.keys().next().value!;
        const removed = this.files.get(oldest)!;
        this.files.delete(oldest);
        bytes -= removed.bytes;
        nodes -= removed.document.nodes.length;
      }
      return file;
    } catch (error) {
      this.files.delete(path);
      throw error;
    }
  }
}

/** Runs in the worker: parsing, schema validation and hashing never occupy the main loop. */
export async function readDesignFile(path: string): Promise<ParsedDesignFile> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = designFileStamp(await stat(path, { bigint: true }));
    const data = z
      .object({
        id: z.uuid(),
        name: z.string().min(1).max(120),
        document: z.unknown(),
        folderId: z.uuid().nullable().optional(),
      })
      .parse(JSON.parse((await readLocalFile(path)).toString("utf8")));
    if (basename(path) !== `${data.id}.json`)
      throw new Error("Design ID does not match its filename.");
    const document = parseDesignDocument(data.document);
    const info = await stat(path, { bigint: true });
    const stamp = designFileStamp(info);
    if (before !== stamp) continue;
    return {
      id: data.id,
      name: data.name,
      folderId: data.folderId ?? null,
      nodeCount: document.nodes.length,
      path,
      stamp,
      bytes: Number(info.size),
      updatedAt: new Date(Number(info.mtimeMs)).toISOString(),
      document,
      version: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    };
  }
  throw new Error("This design is changing on disk. Try again.");
}
