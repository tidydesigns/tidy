import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankDesignDocument } from "@tidy/design/document";
import { DesignFileCache } from "./design-file";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-design-cache-"));
  directories.push(directory);
  const id = randomUUID();
  const path = join(directory, `${id}.json`);
  const source = { id, name: "Before", document: blankDesignDocument() };
  await writeFile(path, JSON.stringify(source));
  return { directory, path, source, cache: new DesignFileCache() };
}

test("worker metadata and scene reads reuse only the same validated disk state", async () => {
  const { cache, path, source } = await fixture();
  const first = await cache.read(path);
  expect(await cache.read(path)).toBe(first);
  const before = await stat(path);
  await writeFile(path, JSON.stringify({ ...source, name: "Edited" }));
  await utimes(path, before.atime, before.mtime);
  const changed = await cache.read(path);
  expect(changed).not.toBe(first);
  expect(changed.name).toBe("Edited");
  expect(changed.version).not.toBe(first.version);
  expect(await cache.read(path)).toBe(changed);
});

test("cached files still reject invalid replacements and symlinks and recover on repair", async () => {
  const { cache, path, source, directory } = await fixture();
  const first = await cache.read(path);
  await writeFile(path, JSON.stringify({ ...source, document: { nodes: [{ type: "invalid" }] } }));
  await expect(cache.read(path)).rejects.toThrow();
  await writeFile(path, JSON.stringify(source));
  expect((await cache.read(path)).version).toBe(first.version);
  const target = join(directory, "target.json");
  await writeFile(target, JSON.stringify(source));
  await rm(path);
  await symlink(target, path);
  await expect(cache.read(path)).rejects.toThrow("symbolic links");
  await rm(path);
  await writeFile(path, JSON.stringify({ ...source, id: randomUUID() }));
  await expect(cache.read(path)).rejects.toThrow("filename");
  await rm(path);
  await expect(cache.read(path)).rejects.toThrow();
});

test("worker cache evicts old scenes instead of retaining every scanned design", async () => {
  const { cache, path, source, directory } = await fixture();
  const first = await cache.read(path);
  for (let index = 0; index < 4; index++) {
    const id = randomUUID();
    const other = join(directory, `${id}.json`);
    await writeFile(other, JSON.stringify({ ...source, id }));
    await cache.read(other);
  }
  expect(await cache.read(path)).not.toBe(first);
});
