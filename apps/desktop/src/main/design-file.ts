import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { parseDesignDocument } from "@tidy/design/document";
import { readLocalFile } from "./local-files";
import type { LocalDesign } from "../shared/contracts";

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
