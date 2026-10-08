import { describe, expect, mock, test } from "bun:test";
import { blankDesignDocument, parseDesignDocument, type DesignNode } from "@bella/design/document";
import { mergeImport } from "@/lib/design/merge-import";
import { importWebCapture } from "./import";

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
    getDesignFile: mock(async () => ({
      id: fileId,
      name: "File",
      organizationId: "org",
      role: "editor",
      organizationName: "Org",
      folderId: null,
      archivedAt: null,
      updatedAt: new Date(),
      frames: [],
      rectangles: [],
    })),
    createImport: mock(async () => ({
      importId: fileId,
      expectedRevision: 1,
      expiresInHours: 24,
      maxNodes: 5000,
      maxChunkNodes: 250,
    })),
    putAsset: mock(async () => ({ assetId: uploadedId, sha256: "hash" })),
    putImportChunk: mock(
      async (
        _user: string,
        _import: string,
        _chunk: string,
        nodes: unknown[],
        source?: unknown,
      ) => {
        chunks.push({ nodes, source });
        return { chunkId: _chunk, chunkCount: chunks.length };
      },
    ),
    validateImport: mock(async () => ({
      nodeCount: 2,
      artboardCount: 1,
      warnings: [],
      layout: { valid: true, issues: [], visualVerification: "required" as const },
    })),
    commitImport: mock(
      async (
        _user: string,
        _import: string,
        _resolution?: "keep_user" | "use_import" | "duplicate",
      ) => {
        void _user;
        void _import;
        void _resolution;
        return { fileId, revision: 2, url: `/files/${fileId}`, nodeCount: 2, warnings: [] };
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
    await expect(importWebCapture("user", mismatched, deps)).rejects.toThrow("access denied");
    expect(deps.putAsset).not.toHaveBeenCalled();
  });
  test("uploads assets, remaps node IDs, validates, and commits an independent copy", async () => {
    const deps = services();
    const result = await importWebCapture("user", input(), deps);
    expect(result.fileId).toBe(fileId);
    expect(deps.validateImport).toHaveBeenCalledTimes(1);
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
    deps.validateImport.mockImplementation(async () => {
      throw new Error("Asset missing");
    });
    await expect(importWebCapture("user", input(), deps)).rejects.toThrow("Asset missing");
    expect(deps.abortImport).toHaveBeenCalledWith("user", fileId);
    expect(deps.commitImport).not.toHaveBeenCalled();
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
