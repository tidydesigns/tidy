import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Reject unsafe paths, duplicates and malformed contents before any files are staged. */
function validateFiles(files) {
  const names = new Set();
  if (!Array.isArray(files)) throw new Error("Invalid desktop demo snapshot files.");
  for (const file of files) {
    const name = file?.path;
    if (
      typeof name !== "string" ||
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      names.has(name) ||
      typeof file.content !== "string" ||
      file.content.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
    )
      throw new Error("Invalid desktop demo snapshot entry.");
    names.add(name);
  }
  if (!names.has("index.html")) throw new Error("Desktop demo snapshot is missing index.html.");
  return files;
}

/** Verify the reviewed pin and decode it within a bounded decompression budget. */
export function unpackSnapshot(bytes, manifest) {
  if (manifest.format !== 1 || checksum(bytes) !== manifest.sha256)
    throw new Error("Desktop demo snapshot checksum or format mismatch.");
  const files = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString());
  return validateFiles(files);
}

/** Capture every built renderer asset in a reproducible, self-contained snapshot. */
export async function packSnapshot(directory) {
  const files = [];
  /** Read regular files in a stable order and reject links or special files. */
  async function visit(relative = "") {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        files.push({
          path: name,
          content: (await readFile(path.join(directory, name))).toString("base64"),
        });
      else throw new Error("Desktop demo snapshots only support regular files.");
    }
  }
  await visit();
  return gzipSync(JSON.stringify(validateFiles(files)), { level: 9 });
}
