import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UpdateResumes } from "./update-resumes";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "tidy-journal-cache-"));
  roots.push(root);
  const journal = new UpdateResumes(root);
  const entry = {
    projectId: randomUUID(),
    threadId: randomUUID(),
    signature: "a".repeat(64),
    previousSignature: "a".repeat(64),
    automaticQueue: false,
    submission: { messageId: randomUUID(), state: "accepted" as const },
  };
  await journal.stage([entry]);
  await journal.get(entry.projectId, entry.threadId);
  return { root, journal, entry, path: join(root, "update-resumes.json") };
}

test("identical checkpoints preserve the durable file and return isolated values", async () => {
  const f = await fixture();
  const before = await fs.stat(f.path, { bigint: true });
  const one = (await f.journal.get(f.entry.projectId, f.entry.threadId))!;
  one.submission!.messageId = randomUUID();
  const all = await f.journal.list();
  all[0].signature = "b".repeat(64);
  await f.journal.checkpoint(f.entry);
  const after = await fs.stat(f.path, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(await f.journal.get(f.entry.projectId, f.entry.threadId)).toEqual(f.entry);
  expect(await f.journal.get(randomUUID(), f.entry.threadId)).toBeUndefined();
  await f.journal.checkpoint({ ...f.entry, signature: "c".repeat(64) });
  expect(JSON.parse(await fs.readFile(f.path, "utf8"))[0].signature).toBe("c".repeat(64));
});

test("checkpoint captures caller-owned fields before its serialized write", async () => {
  const f = await fixture();
  const next = { ...f.entry, signature: "b".repeat(64), submission: { ...f.entry.submission } };
  const writing = f.journal.checkpoint(next);
  next.threadId = randomUUID();
  next.submission.messageId = randomUUID();
  await writing;
  expect((await f.journal.get(f.entry.projectId, f.entry.threadId))?.submission).toEqual(
    f.entry.submission,
  );
  expect(await f.journal.get(f.entry.projectId, next.threadId)).toBeUndefined();
});

for (const change of ["overwrite", "replace", "remove", "symlink"] as const)
  test(`warm journal cache notices external ${change}`, async () => {
    const f = await fixture();
    const original = await fs.stat(f.path);
    const data = JSON.stringify([{ ...f.entry, signature: "b".repeat(64) }]);
    if (change === "overwrite") {
      await fs.writeFile(f.path, data);
      await fs.utimes(f.path, original.atime, original.mtime);
    } else if (change === "replace") {
      await fs.writeFile(f.path + ".replacement", data);
      await fs.rename(f.path + ".replacement", f.path);
    } else {
      await fs.rm(f.path);
      if (change === "symlink") {
        await fs.writeFile(f.path + ".other", data);
        await fs.symlink(f.path + ".other", f.path);
      }
    }
    if (change === "symlink")
      await expect(f.journal.get(f.entry.projectId, f.entry.threadId)).rejects.toThrow("regular");
    else
      expect((await f.journal.get(f.entry.projectId, f.entry.threadId))?.signature).toBe(
        change === "remove" ? undefined : "b".repeat(64),
      );
  });

test("a failed directory sync cannot make an identical retry skip durability", async () => {
  const f = await fixture();
  const open = fs.open;
  const failure = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === f.root)
        handle.sync = async () => {
          throw new Error("Directory sync failed");
        };
      return handle;
    },
  );
  const entry = { ...f.entry, signature: "b".repeat(64) };
  try {
    await expect(f.journal.checkpoint(entry)).rejects.toThrow("Directory sync failed");
  } finally {
    failure.mockRestore();
  }
  const failed = await fs.stat(f.path, { bigint: true });
  await f.journal.checkpoint(entry);
  expect((await fs.stat(f.path, { bigint: true })).ino).not.toBe(failed.ino);
  expect((await f.journal.get(entry.projectId, entry.threadId))?.signature).toBe(entry.signature);
});
