import { describe, expect, mock, test } from "bun:test";
import { blankDesignDocument, parseDesignDocument, type DesignNode } from "@tidy/design/document";
import { mergeImport } from "@/lib/design/merge-import";
mock.module("server-only", () => ({}));
const { importWebCapture } = await import("./import");

const fileId: `${string}-${string}-${string}-${string}-${string}` =
  "00000000-0000-4000-8000-000000000001";
const imageId = "00000000-0000-4000-8000-000000000002";
const uploadedId = "00000000-0000-4000-8000-000000000003";
const frame: DesignNode = {
  id: "frame",
  parentId: null,
  name: "Page",
  type: "artboard",
  box: { x: 0, y: 0, width: 800, height: 600 },
  style: {},
  layout: "absolute",
  locked: false,
  visible: true,
};
function input() {
  return {
    userId: "user",
    organizationId: "org",
    fileId,
    capture: {
      title: "Website",
      url: "https://example.com/page",
      mode: "page",
      document: {
        ...blankDesignDocument(),
        nodes: [
          frame,
          { ...frame, type: "image", id: "image", parentId: "frame", assetId: imageId },
        ],
      },
      assets: [{ id: imageId, mimeType: "image/png", base64: "aGVsbG8=" }],
    },
  };
}
function services() {
  const chunks: { nodes: unknown[]; source: unknown }[] = [];
  return {
    chunks,
    captureReceipt: mock(async () => null),
    createImport: mock(async () => ({
      importId: fileId,
      expectedRevision: 1,
      expiresInHours: 24,
      maxNodes: 5000,
      maxChunkNodes: 250,
    })),
    putAsset: mock(async () => ({ assetId: uploadedId, sha256: "hash" })),
    putImportDocument: mock(
      async (
        _user: string,
        _import: string,
        document: import("@tidy/design/document").DesignDocument,
      ) => {
        chunks.push({ nodes: document.nodes, source: document.source });
      },
    ),
    commitImport: mock(
      async (
        _user: string,
        _import: string,
        _resolution?: "keep_user" | "use_import" | "duplicate",
      ) => {
        void _user;
        void _import;
        void _resolution;
        return {
          fileId,
          revision: 2,
          url: `/files/${fileId}`,
          nodeCount: 2,
          warnings: [] as { message: string }[],
        };
      },
    ),
    abortImport: mock(async () => ({ aborted: true })),
  };
}

describe("web import service", () => {
  test("checks account and organization access before staging any content", async () => {
    const deps = services();
    await expect(importWebCapture("different-user", input(), deps)).rejects.toThrow(
      "account changed",
    );
    expect(deps.createImport).not.toHaveBeenCalled();
    const mismatched = { ...input(), organizationId: "other-org" };
    deps.createImport.mockImplementation(async () => {
      throw new Error("Organization access denied.");
    });
    await expect(importWebCapture("user", mismatched, deps)).rejects.toThrow("access denied");
    expect(deps.putAsset).not.toHaveBeenCalled();
  });
  test("uploads assets, remaps node IDs, validates, and commits an independent copy", async () => {
    const deps = services();
    const result = await importWebCapture("user", input(), deps);
    expect(result.fileId).toBe(fileId);
    expect(deps.putImportDocument).toHaveBeenCalledTimes(1);
    expect(deps.commitImport).toHaveBeenCalledWith("user", fileId, "duplicate");
    const chunk = deps.chunks[0];
    const parsed = parseDesignDocument({ ...blankDesignDocument(), nodes: chunk.nodes });
    expect(parsed.nodes[0].id).not.toBe(frame.id);
    expect(parsed.nodes[1].parentId).toBe(parsed.nodes[0].id);
    expect(parsed.nodes[1].assetId).toBe(uploadedId);
    expect(deps.abortImport).not.toHaveBeenCalled();
  });
  test("capture activity follows accepted work and reveals sanitized source metadata", async () => {
    const deps = services(),
      phases: string[] = [],
      details: unknown[] = [];
    const capture = input();
    capture.capture.url = "https://example.com/page";
    const result = await importWebCapture("user", capture, deps, async (phase, summary) => {
      phases.push(phase);
      details.push(summary);
    });
    expect(phases).toEqual(["receiving", "receiving", "receiving", "validating", "publishing"]);
    expect(details[1]).toMatchObject({ nodeCount: 0, assetCount: 1 });
    expect(details[2]).toMatchObject({ nodeCount: 2, assetCount: 1 });
    expect(result).toMatchObject({ sourceProject: "example.com", sourceRoute: "/page" });
    expect(JSON.stringify(details)).not.toContain("private");
    expect(JSON.stringify(details)).not.toContain("aGVsbG8=");
  });
  test("aborts a failed staging job and never commits partial content", async () => {
    const deps = services();
    deps.putImportDocument.mockImplementation(async () => {
      throw new Error("Asset missing");
    });
    await expect(importWebCapture("user", input(), deps)).rejects.toThrow("Asset missing");
    expect(deps.abortImport).toHaveBeenCalledWith("user", fileId);
    expect(deps.commitImport).not.toHaveBeenCalled();
  });
  test("returns notes from this capture without repeating older file warnings", async () => {
    const deps = services();
    const capture = input();
    capture.capture.document.warnings = [{ message: "Current capture limitation" }];
    deps.commitImport.mockImplementation(async () => ({
      fileId,
      revision: 2,
      url: `/files/${fileId}`,
      nodeCount: 2,
      warnings: [
        { message: "Previous capture limitation" },
        { message: "Current capture limitation" },
      ],
    }));
    const result = await importWebCapture("user", capture, deps);
    expect(result.warnings).toEqual([{ message: "Current capture limitation" }]);
  });
  test("revision conflicts abort instead of overwriting another editor", async () => {
    const deps = services();
    deps.commitImport.mockImplementation(async () => {
      throw new Error("File changed during import.");
    });
    await expect(importWebCapture("user", input(), deps)).rejects.toThrow("File changed");
    expect(deps.abortImport).toHaveBeenCalledTimes(1);
  });
  test("two copies of one website append alongside existing edited layers", async () => {
    const deps = services();
    await importWebCapture("user", input(), deps);
    await importWebCapture("user", input(), deps);
    const current = {
      ...blankDesignDocument(),
      nodes: [{ ...frame, name: "User's frame" }],
      editedNodeIds: [frame.id],
    };
    let document = current;
    for (const chunk of deps.chunks) {
      const source = chunk.source as { project: string; route: string };
      const nodes = (chunk.nodes as DesignNode[]).map((node) => ({
        ...node,
        importKey: `${source.project}:${source.route}`,
      }));
      document = mergeImport(
        document,
        parseDesignDocument({ ...blankDesignDocument(), source, nodes }),
        crypto.randomUUID(),
        "duplicate",
      );
    }
    expect(document.nodes.filter((node) => node.type === "artboard")).toHaveLength(3);
    expect(document.nodes[0].name).toBe("User's frame");
    expect(document.editedNodeIds).toContain(frame.id);
    expect(new Set(document.nodes.map((node) => node.id)).size).toBe(5);
  });
  test("image fill references follow the uploaded asset when a capture is copied", async () => {
    const deps = services(),
      capture = input();
    capture.capture.document.nodes[0] = {
      ...frame,
      style: {
        paints: [
          {
            id: "fill",
            type: "image",
            assetId: imageId,
            opacity: 1,
            visible: true,
            fit: "cover",
            positionX: 50,
            positionY: 50,
          },
        ],
      },
    };
    await importWebCapture("user", capture, deps);
    const copied = parseDesignDocument({ ...blankDesignDocument(), nodes: deps.chunks[0].nodes });
    expect(copied.nodes[0].style.paints?.[0]).toMatchObject({ type: "image", assetId: uploadedId });
    expect(copied.nodes[1].assetId).toBe(uploadedId);
    expect(deps.putAsset).toHaveBeenCalledTimes(1);
  });
});

test("identical referenced images upload once and unused images do not consume storage", async () => {
  const deps = services();
  const capture = input();
  const duplicateId = "00000000-0000-4000-8000-000000000004";
  const unusedId = "00000000-0000-4000-8000-000000000005";
  capture.capture.assets.push(
    { ...capture.capture.assets[0], id: duplicateId },
    { ...capture.capture.assets[0], id: unusedId, base64: "dW51c2Vk" },
  );
  capture.capture.document.nodes.push({
    ...frame,
    id: "duplicate",
    type: "image",
    parentId: "frame",
    assetId: duplicateId,
  });
  await importWebCapture("user", capture, deps);
  expect(deps.putAsset).toHaveBeenCalledTimes(1);
  expect(
    parseDesignDocument({ ...blankDesignDocument(), nodes: deps.chunks[0].nodes })
      .nodes.filter((node) => node.type === "image")
      .map((node) => node.assetId),
  ).toEqual([uploadedId, uploadedId]);
});
test("a maximum-sized capture stages once rather than rewriting twenty growing chunks", async () => {
  const deps = services();
  const capture = input();
  capture.capture.assets = [];
  capture.capture.document.nodes = [
    frame,
    ...Array.from({ length: 4999 }, (_, index) => ({
      ...frame,
      id: `node-${index}`,
      parentId: "frame",
      type: "container" as const,
    })),
  ];
  await importWebCapture("user", capture, deps);
  expect(deps.putImportDocument).toHaveBeenCalledTimes(1);
  expect(deps.chunks[0].nodes).toHaveLength(5000);
});
test("a duplicate in-flight request never stages, uploads, commits, or aborts the original", async () => {
  const deps = {
    ...services(),
    createImport: mock(async () => ({
      importId: fileId,
      alreadyCreated: true,
      expectedRevision: 1,
      expiresInHours: 24,
      maxNodes: 5000,
      maxChunkNodes: 250,
    })),
    captureReceipt: mock(async () => ({ state: "pending" as const })),
  };
  await expect(
    importWebCapture("user", input(), deps, undefined, {
      id: fileId,
      hash: "a".repeat(64),
      createdAt: Date.now(),
    }),
  ).rejects.toThrow("already processing");
  expect(deps.putAsset).not.toHaveBeenCalled();
  expect(deps.putImportDocument).not.toHaveBeenCalled();
  expect(deps.commitImport).not.toHaveBeenCalled();
  expect(deps.abortImport).not.toHaveBeenCalled();
});
