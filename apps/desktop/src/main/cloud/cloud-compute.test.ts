import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankDesignDocument } from "@tidy/design/document";
import { storedThreadSchema } from "../../shared/contracts/desktop";
import { summarizeThread } from "../../shared/models/thread-updates";
import { CloudCompute } from "./cloud-compute";

test("worker cache returns independent scene copies after a metadata scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-worker-cache-"));
  const id = randomUUID();
  const path = join(directory, `${id}.json`);
  const compute = new CloudCompute();
  try {
    await writeFile(path, JSON.stringify({ id, name: "Fixture", document: blankDesignDocument() }));
    const summary = await compute.readSummary(path);
    const first = await compute.readFile(path);
    first.name = "Caller mutation";
    first.document.pages[0].name = "Caller mutation";
    const second = await compute.readFile(path);
    expect(second.name).toBe("Fixture");
    expect(second.document.pages[0].name).toBe("Page 1");
    expect(second.version).toBe(summary.version);
  } finally {
    await compute.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a canvas takes priority over queued metadata decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-file-worker-"));
  const id = randomUUID(),
    path = join(directory, `${id}.json`);
  const compute = new CloudCompute();
  try {
    await writeFile(path, JSON.stringify({ id, name: "Fixture", document: blankDesignDocument() }));
    let summariesCompleted = 0;
    const summaries = Promise.all(
      Array.from({ length: 40 }, () =>
        compute.readSummary(path).then(() => {
          summariesCompleted++;
        }),
      ),
    );
    expect((await compute.readFile(path)).id).toBe(id);
    expect(summariesCompleted).toBeLessThan(40);
    await summaries;
  } finally {
    await compute.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interactive reads take priority over queued full preview reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-preview-priority-"));
  const id = randomUUID(),
    path = join(directory, `${id}.json`);
  const compute = new CloudCompute();
  try {
    await writeFile(path, JSON.stringify({ id, name: "Fixture", document: blankDesignDocument() }));
    let completed = 0;
    const previews = Promise.all(
      Array.from({ length: 40 }, () =>
        compute.readFile(path, true).then(() => {
          completed++;
        }),
      ),
    );
    expect((await compute.readFile(path)).id).toBe(id);
    expect(completed).toBeLessThan(40);
    await previews;
  } finally {
    await compute.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("thread scans yield to interactive design reads and return validated summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-thread-worker-"));
  const id = randomUUID();
  const designPath = join(directory, `${id}.json`);
  const threadPath = join(directory, "thread.json");
  const compute = new CloudCompute();
  try {
    await writeFile(
      designPath,
      JSON.stringify({ id, name: "Fixture", document: blankDesignDocument() }),
    );
    const thread = {
      id: randomUUID(),
      projectId: randomUUID(),
      title: "Saved conversation",
      harness: "codex",
      designIds: [],
      messages: [{ id: randomUUID(), role: "assistant", text: "x".repeat(10_000) }],
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
    await writeFile(threadPath, JSON.stringify(thread));
    let completed = 0;
    const summaries = Promise.all(
      Array.from({ length: 40 }, () =>
        compute.readThreadSummary(threadPath).then((summary) => {
          completed++;
          return summary;
        }),
      ),
    );
    expect((await compute.readFile(designPath)).id).toBe(id);
    expect(completed).toBeLessThan(40);
    const results = await summaries;
    expect(results[0]).toEqual(summarizeThread(storedThreadSchema.parse(thread)));
    expect("messages" in results[0]).toBe(false);
    await writeFile(threadPath, JSON.stringify({ ...thread, messages: [{ role: "invalid" }] }));
    await expect(compute.readThreadSummary(threadPath)).rejects.toThrow();
    await writeFile(threadPath, JSON.stringify(thread));
    expect((await compute.readThreadSummary(threadPath)).id).toBe(thread.id);
  } finally {
    await compute.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing settles pending thread encodings and a later checkpoint restarts the worker", async () => {
  const compute = new CloudCompute();
  const thread = {
    revision: 0,
    id: randomUUID(),
    projectId: randomUUID(),
    title: "Checkpoint",
    harness: "codex",
    designIds: [],
    messages: [{ id: randomUUID(), role: "assistant", text: "Reply".repeat(60_000) }],
    status: "running",
    updatedAt: new Date().toISOString(),
  } satisfies Parameters<CloudCompute["encodeThread"]>[0];
  try {
    const pending = Promise.allSettled([compute.encodeThread(thread)]);
    await compute.close();
    const [result] = await pending;
    if (result.status === "fulfilled")
      expect(new TextDecoder().decode(result.value)).toBe(JSON.stringify(thread, null, 2));
    else
      expect(result.reason).toMatchObject({
        message: "Cloud comparison stopped. Sync will retry.",
      });
    const encoded = await compute.encodeThread(thread);
    expect(new TextDecoder().decode(encoded)).toBe(JSON.stringify(thread, null, 2));
  } finally {
    await compute.close();
  }
});
