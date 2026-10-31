import { expect, test } from "bun:test";
import { mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
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

test("bounded reads preserve bytes across chunks and accept an empty file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-local-chunks-"));
  try {
    const path = join(directory, "bytes.bin");
    const data = Buffer.from("🧭".repeat(40_000));
    await writeFile(path, data);
    expect(await readLocalFile(path, data.length)).toEqual(data);
    await expect(readLocalFile(path, data.length - 1)).rejects.toThrow("too large");
    await writeFile(path, "");
    expect(await readLocalFile(path, 0)).toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "repeated bounded reads release every descriptor for the source file",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tidy-local-descriptors-"));
    try {
      const path = join(directory, "source.json");
      await writeFile(path, "{} ");
      for (let index = 0; index < 100; index++) await readLocalFile(path, 3);
      const targets = await Promise.all(
        (await readdir("/proc/self/fd")).map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => ""),
        ),
      );
      expect(targets.filter((target) => target === path)).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
