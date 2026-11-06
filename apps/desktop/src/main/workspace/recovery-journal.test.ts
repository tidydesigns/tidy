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

for (const change of ["overwrite", "replace", "remove", "invalid", "symlink"] as const)
  test(`a journal ${change} before a native write returns cannot inherit its cached authority`, async () => {
    const f = await fixture();
    const rename = fs.rename;
    let changed = false;
    const racing = spyOn(fs, "rename").mockImplementation(
      async (...args: Parameters<typeof fs.rename>) => {
        await rename(...args);
        if (args[1] === f.path && !changed) {
          changed = true;
          const data = JSON.stringify([{ ...f.entry, signature: "c".repeat(64) }]);
          if (change === "overwrite") await fs.writeFile(f.path, data);
          if (change === "replace") {
            await fs.writeFile(f.path + ".replacement", data);
            await rename(f.path + ".replacement", f.path);
          }
          if (change === "remove" || change === "symlink") await fs.rm(f.path);
          if (change === "invalid") await fs.writeFile(f.path, "[{}]");
          if (change === "symlink") {
            await fs.writeFile(f.path + ".other", data);
            await fs.symlink(f.path + ".other", f.path);
          }
        }
      },
    );
    try {
      await f.journal.checkpoint({ ...f.entry, signature: "b".repeat(64) });
    } finally {
      racing.mockRestore();
    }
    expect(changed).toBe(true);
    if (change === "invalid" || change === "symlink") {
      let rejected = false;
      try {
        await f.journal.get(f.entry.projectId, f.entry.threadId);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } else {
      expect((await f.journal.get(f.entry.projectId, f.entry.threadId))?.signature).toBe(
        change === "remove" ? undefined : "c".repeat(64),
      );
    }
  });

test("restaging a captured checkpoint does not rewrite omitted optional fields", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "tidy-journal-optional-"));
  roots.push(root);
  const journal = new UpdateResumes(root);
  const path = join(root, "update-resumes.json");
  await journal.checkpoint({
    projectId: randomUUID(),
    threadId: randomUUID(),
    signature: "a".repeat(64),
    automaticQueue: false,
    submission: { messageId: randomUUID(), state: "accepted", skillId: undefined },
  });
  const before = await fs.stat(path, { bigint: true });
  await journal.stage(JSON.parse(await fs.readFile(path, "utf8")));
  const after = await fs.stat(path, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
});

test("an oversized journal is rejected before replacing recoverable work", async () => {
  const f = await fixture();
  const before = await fs.readFile(f.path, "utf8");
  const info = await fs.stat(f.path, { bigint: true });
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    ...f.entry,
    threadId: index ? randomUUID() : f.entry.threadId,
    reason: "provider" as const,
    attempt: 1,
    unknownAttempts: 1,
    background: true,
    retryAt: new Date().toISOString(),
    submission: { ...f.entry.submission, skillId: "\0".repeat(128) },
  }));
  expect(Buffer.byteLength(JSON.stringify(entries))).toBeGreaterThan(1024 * 1024);
  await expect(f.journal.stage(entries)).rejects.toThrow("size limit");
  expect(await fs.readFile(f.path, "utf8")).toBe(before);
  await f.journal.checkpoint(f.entry);
  expect((await fs.stat(f.path, { bigint: true })).ino).toBe(info.ino);
  expect(await f.journal.list()).toEqual([f.entry]);
});
