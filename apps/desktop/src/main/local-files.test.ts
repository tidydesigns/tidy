import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalFile } from "./local-files";

test("local reads reject symlinks, directories, and files above their read budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-local-files-"));
  try {
    const path = join(directory, "data.json");
    await writeFile(path, "123456789");
    expect((await readLocalFile(path, 9)).toString()).toBe("123456789");
    await expect(readLocalFile(path, 8)).rejects.toThrow("too large");
    await expect(readLocalFile(directory)).rejects.toThrow("regular files");
    await symlink(path, join(directory, "linked.json"));
    await expect(readLocalFile(join(directory, "linked.json"))).rejects.toThrow("symbolic links");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
