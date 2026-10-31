import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankDesignDocument, buildDrawnNode } from "@tidy/design/document";
import { ProjectStore } from "../../../../main/workspace/project-store";
import { WorkspaceService } from "../../../../main/workspace/workspace-service";
import { createWorkspaceRequests } from "../../../../main/ipc/workspace-requests";
import { parseWorkspaceResponse } from "../../../../shared/contracts/workspace-response";
import type { CloudReferenceDesign, CloudState } from "../../../../shared/contracts/cloud-sync";
import { DraftStore } from "./draft-store";
import {
  cloudReferenceKey,
  importCloudReference,
  toggleProjectCloudReference,
  retryProjectCloudReference,
} from "./cloud-reference";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function until(predicate: () => boolean) {
  for (let count = 0; !predicate(); count++) {
    if (count > 1000) throw new Error("Reference did not settle");
    await Bun.sleep(2);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-cloud-reference-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const backend = new ProjectStore(join(root, "registry"));
  await backend.initialize();
  await mkdir(join(root, "project"));
  const snapshot = await backend.open(join(root, "project"));
  const service = new WorkspaceService(backend);
  cleanup.push(() => service.close());
  const requests = createWorkspaceRequests(service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder: () => {},
  });
  let state: CloudState = { available: true, signedIn: true, accountId: "account", bindings: [] };
  let reads = 0,
    imports = 0;
  let exportDesign: () => Promise<CloudReferenceDesign> = async () => ({
    name: "Cloud design",
    document: blankDesignDocument(),
    assets: {},
  });
  const source = {
    cloud: {
      state: async () => state,
      exportReference: async () => {
        reads++;
        return exportDesign();
      },
    },
  };
  const target = {
    importDraft: async (
      input: Parameters<
        NonNullable<import("../../../../shared/contracts/desktop").DesktopAPI["importDraft"]>
      >[0],
    ) => {
      imports++;
      expect(Object.keys(input).sort()).toEqual(["attachments", "designs", "projectId"]);
      return parseWorkspaceResponse("import-draft", {
        ok: true,
        data: await requests.invoke("import-draft", JSON.parse(JSON.stringify(input)), {}),
      });
    },
  };
  const store = new DraftStore();
  const fallback = { text: "Implement the design", harness: "codex" as const, designIds: [] };
  const reference = {
    accountId: "account",
    organizationId: "org",
    fileId: crypto.randomUUID(),
    name: "Cloud design",
  };
  const input = {
    store,
    machineId: "remote",
    draftKey: `${snapshot.project.id}:new`,
    projectId: snapshot.project.id,
    fallback,
    source,
    target,
    reference,
  };
  return {
    backend,
    store,
    snapshot,
    reference,
    input,
    counts: () => ({ reads, imports }),
    export: (next: typeof exportDesign) => {
      exportDesign = next;
    },
    account: (id?: string) => {
      state = { ...state, accountId: id, signedIn: Boolean(id) };
    },
  };
}

test("cloud references import through the real workspace boundary with fresh IDs and portable image assets", async () => {
  const f = await fixture();
  const document = blankDesignDocument();
  const assetId = crypto.randomUUID();
  const image = {
    ...buildDrawnNode(crypto.randomUUID(), "container", null, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }),
    type: "image" as const,
    assetId,
  };
  document.nodes.push(image);
  const bytes = "data:image/png;base64,aGVsbG8=";
  f.export(async () => ({ name: "Cloud design", document, assets: { [assetId]: bytes } }));
  const result = await importCloudReference({ ...f.input, isCurrent: () => true });
  const imported = await f.backend.readDesign(f.snapshot.project.id, result.designId);
  const importedAsset = imported.document.nodes.find((node) => node.type === "image")?.assetId;
  expect(importedAsset).toBeDefined();
  expect(importedAsset).not.toBe(assetId);
  expect(await f.backend.readSyncAsset(f.snapshot.project.id, importedAsset ?? "")).toBe(bytes);
  expect(f.backend.activeProjectId).toBe(f.snapshot.project.id);
  expect(result.snapshot.project.id).toBe(f.snapshot.project.id);
});

test("rapid toggle-off/toggle-on shares one import, stays selected immediately, and preserves ongoing typing", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<CloudReferenceDesign>();
  f.export(() => release.promise);
  toggleProjectCloudReference(f.input);
  expect(f.store.get("remote")[f.input.draftKey].cloudReferences?.[0].kind).toBe("pending");
  await until(() => f.counts().reads === 1);
  toggleProjectCloudReference(f.input);
  expect(f.store.get("remote")[f.input.draftKey].cloudReferences).toHaveLength(0);
  toggleProjectCloudReference(f.input);
  f.store.update("remote", (current) => ({
    ...current,
    [f.input.draftKey]: { ...current[f.input.draftKey], text: "Keep this newer prompt" },
  }));
  release.resolve({ name: "Design", document: blankDesignDocument(), assets: {} });
  await until(() => f.store.get("remote")[f.input.draftKey].cloudReferences?.[0].kind === "ready");
  expect(f.counts()).toEqual({ reads: 1, imports: 1 });
  expect(f.store.get("remote")[f.input.draftKey].text).toBe("Keep this newer prompt");
});

test("deselecting during a download prevents import and a late completion never restores selection", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<CloudReferenceDesign>();
  f.export(() => release.promise);
  toggleProjectCloudReference(f.input);
  await until(() => f.counts().reads === 1);
  const pending = f.store.references.prepare({ ...f.input, isCurrent: () => true });
  toggleProjectCloudReference(f.input);
  release.resolve({ name: "Design", document: blankDesignDocument(), assets: {} });
  await expect(pending).rejects.toThrow("Reference removed");
  expect(f.counts().imports).toBe(0);
  expect(f.store.get("remote")[f.input.draftKey].cloudReferences).toHaveLength(0);
});

test("network failures remain removable, retry succeeds, and failures do not discard the prompt or project references", async () => {
  const f = await fixture();
  f.export(async () => {
    throw new Error("Offline");
  });
  f.store.update("remote", {
    [f.input.draftKey]: { ...f.input.fallback, designIds: ["local-design"] },
  });
  toggleProjectCloudReference(f.input);
  await until(() => f.store.get("remote")[f.input.draftKey].cloudReferences?.[0].kind === "error");
  const failed = f.store.get("remote")[f.input.draftKey].cloudReferences?.[0];
  expect(failed?.kind === "error" && failed.message).toBe(
    "Could not prepare this reference. Try again.",
  );
  f.export(async () => ({ name: "Design", document: blankDesignDocument(), assets: {} }));
  retryProjectCloudReference({ ...f.input, token: failed?.token ?? "" });
  await until(() => f.store.get("remote")[f.input.draftKey].cloudReferences?.[0].kind === "ready");
  expect(f.store.get("remote")[f.input.draftKey]).toMatchObject({
    text: f.input.fallback.text,
    designIds: ["local-design"],
  });
  expect(f.counts()).toEqual({ reads: 2, imports: 1 });
});

test("account changes during download prevent reference bytes reaching the destination", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<CloudReferenceDesign>();
  f.export(() => release.promise);
  toggleProjectCloudReference(f.input);
  await until(() => f.counts().reads === 1);
  f.account("other-account");
  release.resolve({ name: "Design", document: blankDesignDocument(), assets: {} });
  await until(() => f.store.get("remote")[f.input.draftKey].cloudReferences?.[0].kind === "error");
  expect(f.counts().imports).toBe(0);
});

test("mixed project and cloud references obey one 20-reference limit", async () => {
  const f = await fixture();
  f.store.update("remote", {
    [f.input.draftKey]: {
      ...f.input.fallback,
      designIds: Array.from({ length: 20 }, () => crypto.randomUUID()),
    },
  });
  toggleProjectCloudReference(f.input);
  expect(f.store.get("remote")[f.input.draftKey].cloudReferences).toBeUndefined();
  expect(f.counts()).toEqual({ reads: 0, imports: 0 });
});

test("same-named designs in different workspaces keep separate identities and background work survives navigation", async () => {
  const f = await fixture();
  const other = { ...f.reference, organizationId: "second-org", fileId: crypto.randomUUID() };
  expect(cloudReferenceKey(other)).not.toBe(cloudReferenceKey(f.reference));
  toggleProjectCloudReference(f.input);
  toggleProjectCloudReference({ ...f.input, reference: other });
  f.store.update("local", { "unrelated:new": { ...f.input.fallback, text: "Different project" } });
  await until(
    () =>
      f.store
        .get("remote")
        [f.input.draftKey].cloudReferences?.filter((reference) => reference.kind === "ready")
        .length === 2,
  );
  expect(f.store.get("local")["unrelated:new"].text).toBe("Different project");
  const references = f.store.get("remote")[f.input.draftKey].cloudReferences ?? [];
  expect(
    new Set(references.map((reference) => (reference.kind === "ready" ? reference.designId : "")))
      .size,
  ).toBe(2);
});

test("older destinations and oversized references fail without writing to the destination", async () => {
  const f = await fixture();
  await expect(
    importCloudReference({ ...f.input, target: {}, isCurrent: () => true }),
  ).rejects.toThrow("Update Tidy");
  f.export(async () => ({
    name: "Design",
    document: blankDesignDocument(),
    assets: { [crypto.randomUUID()]: "x".repeat(3_000_001) },
  }));
  await expect(importCloudReference({ ...f.input, isCurrent: () => true })).rejects.toThrow();
  expect(f.counts().imports).toBe(0);
});

test("reattaching after the brief deduplication window fetches a fresh cloud snapshot", async () => {
  const f = await fixture();
  const { CloudReferenceImports } = await import("./cloud-reference");
  let now = 0;
  const imports = new CloudReferenceImports(() => now);
  const input = { ...f.input, isCurrent: () => true };
  const first = await imports.prepare(input);
  expect((await imports.prepare(input)).designId).toBe(first.designId);
  now = 31_000;
  f.export(async () => ({
    name: "Updated cloud design",
    document: blankDesignDocument(),
    assets: {},
  }));
  const latest = await imports.prepare(input);
  expect(latest.designId).not.toBe(first.designId);
  expect((await f.backend.readDesign(f.snapshot.project.id, latest.designId)).name).toBe(
    "Updated cloud design",
  );
  expect(f.counts()).toEqual({ reads: 2, imports: 2 });
});
