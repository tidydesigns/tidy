import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../../../../main/workspace/project-store";
import { WorkspaceService } from "../../../../main/workspace/workspace-service";
import { createWorkspaceRequests } from "../../../../main/ipc/workspace-requests";
import { parseWorkspaceResponse } from "../../../../shared/contracts/workspace-response";
import { attachmentReference } from "../../../../shared/models/attachment-references";
import { copyDraft } from "./machine-context";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-draft-transfer-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(join(root, "state"));
  await store.initialize();
  const service = new WorkspaceService(store);
  cleanups.push(() => service.close());
  await mkdir(join(root, "project"));
  const { project } = await store.open(join(root, "project"));
  const requests = createWorkspaceRequests(service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder: () => {},
  });
  return { project, store, service, requests };
}

test("copies selected designs and non-image attachments between real project stores without reusing source IDs", async () => {
  const source = await fixture();
  const target = await fixture();
  const original = await source.store.createDesign(source.project.id);
  const image = await source.store.uploadDesignAsset(
    source.project.id,
    "data:image/png;base64,aGVsbG8=",
  );
  const document = structuredClone(original.document);
  document.nodes.push({
    id: crypto.randomUUID(),
    type: "image",
    parentId: document.nodes[0].id,
    pageId: document.pages[0].id,
    name: "Reference image",
    visible: true,
    locked: false,
    box: { x: 0, y: 0, width: 100, height: 100 },
    layout: "absolute",
    style: {},
    assetId: image.assetId,
  });
  const design = await source.store.updateDesign({
    projectId: source.project.id,
    designId: original.id,
    expectedVersion: original.version,
    document,
  });
  const attachment = await source.store.addAttachment(
    source.project.id,
    "notes.txt",
    "data:text/plain;base64,aGVsbG8=",
  );
  const referenceId = crypto.randomUUID();
  const { draft } = await copyDraft({
    api: {
      exportAttachment: async (projectId, attachmentId) =>
        parseWorkspaceResponse("export-attachment", {
          ok: true,
          data: await source.requests.invoke("export-attachment", { projectId, attachmentId }, {}),
        }),
      exportDesign: async (projectId, designId) =>
        parseWorkspaceResponse("export-design", {
          ok: true,
          data: await source.requests.invoke("export-design", { projectId, designId }, {}),
        }),
    },
    source: {
      project: source.project,
      contextProjectId: source.project.id,
      draft: {
        text: `Read ${attachmentReference({ id: referenceId })} before continuing`,
        harness: "codex",
        designIds: [design.id],
        attachments: [{ ...attachment, referenceId }],
        executionProjectId: source.project.id,
      },
    },
    target: {
      importDraft: async (input) =>
        parseWorkspaceResponse("import-draft", {
          ok: true,
          data: await target.requests.invoke("import-draft", input, {}),
        }),
    },
    projectId: target.project.id,
  });
  expect(draft.text).toBe(`Read [[attachment:${draft.attachments?.[0].id}]] before continuing`);
  expect(draft.text).not.toContain(referenceId);
  expect(draft.text).not.toContain(attachment.id);
  expect(draft.executionProjectId).toBeUndefined();
  expect(draft.designIds[0]).not.toBe(design.id);
  expect(draft.attachments?.[0].id).not.toBe(attachment.id);
  const copied = await target.store.resolveAttachment(
    target.project.id,
    draft.attachments?.[0].id ?? "",
  );
  expect(await readFile(copied.path, "utf8")).toBe("hello");
  const imported = await target.store.readDesign(target.project.id, draft.designIds[0]);
  const importedImage = imported.document.nodes.find((node) => node.type === "image");
  expect(importedImage?.assetId).toBeDefined();
  expect(importedImage?.assetId).not.toBe(image.assetId);
  expect(await target.store.readSyncAsset(target.project.id, importedImage?.assetId ?? "")).toBe(
    "data:image/png;base64,aGVsbG8=",
  );
  expect((await source.store.snapshot(source.project.id)).designs).toHaveLength(1);
});

test("export operations require current access to their project", async () => {
  const source = await fixture();
  const design = await source.store.createDesign(source.project.id);
  await source.store.register(source.project.path, "Shared workspace");
  await expect(
    source.requests.invoke(
      "export-design",
      { projectId: source.project.id, designId: design.id },
      {},
    ),
  ).rejects.toThrow("Open this cloud workspace");
  await expect(
    source.requests.invoke(
      "export-attachment",
      { projectId: source.project.id, attachmentId: crypto.randomUUID() },
      {},
    ),
  ).rejects.toThrow("Open this cloud workspace");
});

test("cancelling after a source read prevents writes to the destination", async () => {
  const source = await fixture();
  const target = await fixture();
  const design = await source.store.createDesign(source.project.id);
  const controller = new AbortController();
  const work = copyDraft({
    api: {
      exportDesign: async (projectId, designId) => {
        const result = parseWorkspaceResponse("export-design", {
          ok: true,
          data: await source.requests.invoke("export-design", { projectId, designId }, {}),
        });
        controller.abort();
        return result;
      },
    },
    source: {
      project: source.project,
      contextProjectId: source.project.id,
      draft: { text: "Keep this draft", harness: "codex", designIds: [design.id] },
    },
    target: {
      importDraft: async (input) =>
        parseWorkspaceResponse("import-draft", {
          ok: true,
          data: await target.requests.invoke("import-draft", input, {}),
        }),
    },
    projectId: target.project.id,
    signal: controller.signal,
  });
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  expect((await target.store.snapshot(target.project.id)).designs).toHaveLength(0);
  expect((await source.store.snapshot(source.project.id)).designs).toHaveLength(1);
});

test("project setup cannot reclassify a registered cloud workspace as local", async () => {
  const source = await fixture();
  await source.store.register(source.project.path, "Shared workspace");
  await expect(
    source.requests.invoke(
      "setup-project",
      { kind: "folder", path: source.project.path, repository: null },
      {},
    ),
  ).rejects.toThrow("cloud workspace");
  expect(source.store.project(source.project.id).cloud).toBe(true);
});

test("draft imports require current project access before staging", async () => {
  const target = await fixture();
  await target.store.register(target.project.path, "Shared workspace");
  await expect(
    target.requests.invoke(
      "import-draft",
      {
        projectId: target.project.id,
        attachments: [],
        designs: [],
      },
      {},
    ),
  ).rejects.toThrow("Open this cloud workspace");
});
