import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankDesignDocument } from "@tidy/design/document";
import { draftImportSchema } from "../../shared/contracts/draft-import";
import { ProjectStore } from "./project-store";
import { DraftImports } from "./draft-imports";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
class FailingStore extends ProjectStore {
  failSnapshot = false;
  override async snapshot(projectId: string) {
    if (this.failSnapshot) throw new Error("Snapshot failed after publication");
    return super.snapshot(projectId);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "draft-import-"));
  roots.push(root);
  const state = join(root, "state");
  const store = new FailingStore(state);
  await store.initialize();
  const path = join(root, "project");
  await mkdir(path);
  const { project } = await store.open(path);
  const imports = new DraftImports(store, async () => {});
  return { store, project, imports, state };
}
const attachment = { name: "notes.txt", dataUrl: "data:text/plain;base64,aGVsbG8=" };

test("invalid later files leave no imports or staging data and preserve existing files", async () => {
  const f = await fixture();
  const existing = await f.store.addAttachment(f.project.id, attachment.name, attachment.dataUrl);
  const before = await readdir(await f.store.storagePath(f.project.id, "attachments"));
  await expect(
    f.imports.import({
      projectId: f.project.id,
      attachments: [attachment, { name: "bad.txt", dataUrl: "invalid" }],
      designs: [],
    }),
  ).rejects.toThrow();
  expect(await readdir(await f.store.storagePath(f.project.id, "attachments"))).toEqual(before);
  expect(
    await readFile((await f.store.resolveAttachment(f.project.id, existing.id)).path, "utf8"),
  ).toBe("hello");
  expect(await readdir(f.store.draftImportDirectory)).toEqual([]);
});

test("failure after publication rolls back all owned files", async () => {
  const f = await fixture();
  f.store.failSnapshot = true;
  await expect(
    f.imports.import({
      projectId: f.project.id,
      attachments: [attachment],
      designs: [{ name: "Reference", document: blankDesignDocument(), assets: {} }],
    }),
  ).rejects.toThrow("Snapshot failed after publication");
  for (const kind of ["assets", "attachments", "designs"] as const)
    expect(await readdir(await f.store.storagePath(f.project.id, kind))).toEqual([]);
  expect(await readdir(f.store.draftImportDirectory)).toEqual([]);
});

async function interrupted(
  f: Awaited<ReturnType<typeof fixture>>,
  state: "publishing" | "committed",
) {
  const id = randomUUID();
  const stage = join(await f.store.storagePath(f.project.id, "attachments"), `.import-${id}`);
  await mkdir(stage);
  const staged = new ProjectStore(join(stage, "state"));
  await staged.initialize();
  const { project } = await staged.open(stage);
  const file = await staged.addAttachment(project.id, attachment.name, attachment.dataUrl);
  const directory = await staged.storagePath(project.id, "attachments");
  const files = (await readdir(directory)).map((name) => ({ kind: "attachments", name }));
  for (const { name } of files)
    await link(
      join(directory, name),
      join(await f.store.storagePath(f.project.id, "attachments"), name),
    );
  await mkdir(f.store.draftImportDirectory, { recursive: true });
  await writeFile(
    join(f.store.draftImportDirectory, `${f.project.id}.${id}.json`),
    JSON.stringify({
      projectId: f.project.id,
      id,
      state,
      files,
    }),
  );
  return { stage, file, files };
}

test("restart removes an unfinished import without deleting a replacement file", async () => {
  const f = await fixture();
  const { file } = await interrupted(f, "publishing");
  const replaced = await f.store.storagePath(f.project.id, "attachments", file.id);
  await rm(replaced);
  await writeFile(replaced, "unrelated replacement");
  const reopened = new ProjectStore(f.state);
  await reopened.initialize();
  await new DraftImports(reopened, async () => {}).recover(f.project.id);
  expect(await readdir(await f.store.storagePath(f.project.id, "attachments"))).toEqual([
    `${file.id}.json`,
  ]);
  expect(await readFile(replaced, "utf8")).toBe("unrelated replacement");
  expect(await readdir(f.store.draftImportDirectory)).toEqual([]);
});

test("restart preserves committed imports and removes their staging data", async () => {
  const f = await fixture();
  const { file, files } = await interrupted(f, "committed");
  const reopened = new ProjectStore(f.state);
  await reopened.initialize();
  await new DraftImports(reopened, async () => {}).recover(f.project.id);
  expect((await readdir(await f.store.storagePath(f.project.id, "attachments"))).sort()).toEqual(
    files.map(({ name }) => name).sort(),
  );
  expect(
    await readFile((await reopened.resolveAttachment(f.project.id, file.id)).path, "utf8"),
  ).toBe("hello");
  expect(await readdir(f.store.draftImportDirectory)).toEqual([]);
});

test("invalid journal paths cannot remove project files", async () => {
  const f = await fixture();
  const existing = await f.store.createDesign(f.project.id);
  await mkdir(f.store.draftImportDirectory, { recursive: true });
  await writeFile(
    join(f.store.draftImportDirectory, `${f.project.id}.${randomUUID()}.json`),
    JSON.stringify({
      projectId: f.project.id,
      id: randomUUID(),
      state: "publishing",
      files: [{ kind: "designs", name: "../../project.json" }],
    }),
  );
  await expect(f.imports.recover(f.project.id)).rejects.toThrow();
  expect((await f.store.snapshot(f.project.id)).designs.map(({ id }) => id)).toEqual([existing.id]);
});

test("import requests reject oversized batches before destination writes", () => {
  expect(
    draftImportSchema.safeParse({
      projectId: randomUUID(),
      attachments: Array.from({ length: 10 }, () => ({
        name: "large.txt",
        dataUrl: "a".repeat(2_900_000),
      })),
      designs: [],
    }).success,
  ).toBe(false);
});

test("revoking access before commit rolls back the published files", async () => {
  const f = await fixture();
  let checks = 0;
  const imports = new DraftImports(f.store, async () => {
    if (++checks === 3) throw new Error("Project access revoked");
  });
  await expect(
    imports.import({ projectId: f.project.id, attachments: [attachment], designs: [] }),
  ).rejects.toThrow("Project access revoked");
  expect(await readdir(await f.store.storagePath(f.project.id, "attachments"))).toEqual([]);
  expect(await readdir(f.store.draftImportDirectory)).toEqual([]);
});
