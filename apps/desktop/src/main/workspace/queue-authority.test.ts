import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../../shared/contracts/desktop";
import type { QueuedMessage } from "../../shared/contracts/message-queue";
import { QueueAuthority } from "./queue-authority";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-queue-authority-"));
  directories.push(directory);
  const authority = new QueueAuthority(directory);
  await authority.initialize();
  const thread: Pick<Thread, "id" | "projectId" | "harness" | "settings"> = {
    id: randomUUID(),
    projectId: randomUUID(),
    harness: "codex",
    settings: { permissionMode: "read-only" },
  };
  const message: QueuedMessage = {
    id: randomUUID(),
    text: "Inspect the design",
    executionConstraint: { harness: "codex", permissionMode: "read-only" },
  };
  return { authority, directory, thread, message, projectPath: join(directory, "project") };
}

test("queue authority survives restart and rejects constraint removal, downgrade, and text replacement", async () => {
  const f = await fixture();
  await f.authority.trust(f.projectPath, f.thread, f.message);
  const restarted = new QueueAuthority(f.directory);
  await restarted.initialize();
  await restarted.verify(f.projectPath, f.thread, f.message);
  for (const tampered of [
    { ...f.message, executionConstraint: undefined },
    {
      ...f.message,
      executionConstraint: { harness: "codex" as const, permissionMode: "auto" as const },
    },
    { ...f.message, text: "Replace the design" },
  ]) {
    await expect(restarted.verify(f.projectPath, f.thread, tampered, true)).rejects.toThrow(
      "changed outside Tidy",
    );
  }
  await expect(
    restarted.verify(
      f.projectPath,
      {
        ...f.thread,
        settings: { permissionMode: "auto" },
      },
      f.message,
      true,
    ),
  ).rejects.toThrow("original permissions");
});

test("explicit queue editing updates content without raising the original permission ceiling", async () => {
  const f = await fixture();
  await f.authority.trust(f.projectPath, f.thread, f.message);
  const next = { ...f.message, text: "Inspect another frame" };
  await f.authority.edit(f.projectPath, f.thread, f.message, next);
  await f.authority.verify(f.projectPath, f.thread, next);
  await expect(f.authority.verify(f.projectPath, f.thread, f.message)).rejects.toThrow(
    "changed outside Tidy",
  );
  await expect(
    f.authority.verify(
      f.projectPath,
      {
        ...f.thread,
        settings: { permissionMode: "auto" },
      },
      next,
    ),
  ).rejects.toThrow("original permissions");
});

test("queue authority binds attachment identities and rejects an altered portable permission ceiling", async () => {
  const f = await fixture();
  const message = {
    ...f.message,
    attachments: [{ id: randomUUID(), name: "notes.txt", mimeType: "text/plain", size: 10 }],
  };
  await f.authority.trust(f.projectPath, f.thread, message);
  await expect(
    f.authority.verify(
      f.projectPath,
      f.thread,
      {
        ...message,
        attachments: [{ ...message.attachments[0], id: randomUUID() }],
      },
      true,
    ),
  ).rejects.toThrow("changed outside Tidy");
  await expect(
    f.authority.edit(f.projectPath, f.thread, message, {
      ...message,
      executionConstraint: undefined,
    }),
  ).rejects.toThrow("original permissions");
});

test("imported queue entries require explicit approval and cannot borrow another identity's authority", async () => {
  const f = await fixture();
  await expect(f.authority.verify(f.projectPath, f.thread, f.message)).rejects.toThrow(
    "explicitly",
  );
  await f.authority.verify(f.projectPath, f.thread, f.message, true);
  for (const thread of [
    { ...f.thread, id: randomUUID() },
    { ...f.thread, projectId: randomUUID() },
  ]) {
    await expect(f.authority.verify(f.projectPath, thread, f.message)).rejects.toThrow(
      "explicitly",
    );
  }
  await expect(f.authority.verify(`${f.projectPath}-copy`, f.thread, f.message)).rejects.toThrow(
    "explicitly",
  );
});
