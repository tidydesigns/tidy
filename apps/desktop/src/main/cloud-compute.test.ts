import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankDesignDocument } from "@tidy/design/document";
import { CloudCompute } from "./cloud-compute";

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
