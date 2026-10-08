import { expect, test } from "bun:test";
import { transferClipboardAssets } from "./clipboard-assets";
import { clipboardAssetIds, remapClipboardAssets, type DesignClipboard } from "./clipboard";
import { buildDrawnNode } from "./document";

const first = "00000000-0000-4000-8000-000000000001",
  second = "00000000-0000-4000-8000-000000000002";
const copied = "00000000-0000-4000-8000-000000000003";
function setup() {
  const writes: string[] = [],
    reads: string[] = [];
  const state = { source: true, target: true, targetRole: "editor", sameOrganization: false };
  let admitted = 0;
  const deps: NonNullable<Parameters<typeof transferClipboardAssets>[3]> = {
    admit: async () => {
      admitted++;
    },
    withAccess: async (_user, _source, _target, work) => {
      if (!state.source || !state.target || state.targetRole !== "editor")
        throw new Error("Access denied");
      return work({
        sourceOrganizationId: "source-org",
        targetOrganizationId: state.sameOrganization ? "source-org" : "target-org",
      });
    },
    assets: async (_user, org, ids) => {
      expect(org).toBe("source-org");
      return ids
        .filter((id) => id === first)
        .map((id) => ({
          id,
          mimeType: "image/png",
          objectKey: "originals/source-org/image.png",
          sha256: "hash",
          byteSize: 4,
        }));
    },
    bytes: async (_user, org, asset) => {
      reads.push(`${org}:${asset.id}`);
      return Buffer.from("test");
    },
    put: async (_user, org, mime, bytes) => {
      writes.push(org);
      expect(mime).toBe("image/png");
      expect(bytes).toBe(Buffer.from("test").toString("base64"));
      return { assetId: copied, sha256: "hash" };
    },
  };
  return { deps, writes, reads, state, admitted: () => admitted };
}

test("cross-organization clipboard copies authorized bytes into destination ownership and deduplicates IDs", async () => {
  const { deps, writes, reads } = setup();
  expect(
    await transferClipboardAssets(
      "user",
      "target",
      { sourceFile: "source", assetIds: [first, first] },
      deps,
    ),
  ).toEqual({ [first]: copied });
  expect(reads).toEqual([`source-org:${first}`]);
  expect(writes).toEqual(["target-org"]);
});
test("same-organization clipboard reuses IDs without copying bytes", async () => {
  const { deps, writes, reads, state } = setup();
  state.sameOrganization = true;
  expect(
    await transferClipboardAssets(
      "user",
      "target",
      { sourceFile: "source", assetIds: [first] },
      deps,
    ),
  ).toEqual({ [first]: first });
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
});
test("missing membership, viewer destination, and foreign asset IDs fail before copying any bytes", async () => {
  for (const denial of ["source", "target", "viewer", "foreign"]) {
    const { deps, writes, reads, state } = setup();
    if (denial === "source") state.source = false;
    if (denial === "target") state.target = false;
    if (denial === "viewer") state.targetRole = "viewer";
    await expect(
      transferClipboardAssets(
        "user",
        "target",
        { sourceFile: "source", assetIds: denial === "foreign" ? [first, second] : [first] },
        deps,
      ),
    ).rejects.toThrow();
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  }
});
test("oversized transfers fail before reading bytes", async () => {
  const { deps, reads } = setup();
  deps.assets = async () => [
    { id: first, mimeType: "image/png", objectKey: null, sha256: "hash", byteSize: 2_000_001 },
  ];
  await expect(
    transferClipboardAssets("user", "target", { sourceFile: "source", assetIds: [first] }, deps),
  ).rejects.toThrow("smaller selection");
  expect(reads).toEqual([]);
});
test("asset remapping includes hidden fills, variant images/fills and resolved detached instances", () => {
  const node = {
    ...buildDrawnNode("node", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    type: "image" as const,
    assetId: first,
    isComponent: true,
    style: {
      paints: [
        {
          id: "fill",
          type: "image" as const,
          assetId: first,
          visible: false,
          opacity: 1,
          fit: "cover" as const,
          positionX: 50,
          positionY: 50,
        },
      ],
    },
    variants: { default: "main", options: { main: {}, alternate: { root: { assetId: second } } } },
  };
  const payload: DesignClipboard = {
    bellaClipboard: 1,
    kind: "layers",
    sourceFile: "source",
    nodes: [node],
    tokens: {},
    resolvedNodes: [{ ...node, id: "resolved", assetId: second }],
  };
  expect(clipboardAssetIds(payload)).toEqual([first, second]);
  expect(() => remapClipboardAssets(payload, { [first]: copied })).toThrow("could not be copied");
  const result = remapClipboardAssets(payload, { [first]: copied, [second]: first });
  expect(result.nodes[0].assetId).toBe(copied);
  expect(result.nodes[0].style.paints?.[0]).toMatchObject({ assetId: copied, visible: false });
  expect(result.nodes[0].variants?.options.alternate.root?.assetId).toBe(first);
  expect(result.resolvedNodes?.[0].assetId).toBe(first);
  expect(payload.nodes[0].assetId).toBe(first);
});

test("transport loading and malformed direct input consume admission first", async () => {
  const { deps, admitted, reads, writes } = setup();
  await expect(
    transferClipboardAssets(
      "user",
      "target",
      async () => {
        expect(admitted()).toBe(1);
        throw new Error("Malformed body");
      },
      deps,
    ),
  ).rejects.toThrow("Malformed body");
  await expect(
    transferClipboardAssets(
      "user",
      "target",
      { sourceFile: "source", assetIds: ["invalid"] },
      deps,
    ),
  ).rejects.toThrow("Invalid clipboard");
  expect(admitted()).toBe(2);
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
  deps.admit = async () => {
    throw new Error("Budget unavailable");
  };
  let loaded = false;
  await expect(
    transferClipboardAssets(
      "user",
      "target",
      async () => {
        loaded = true;
        return {};
      },
      deps,
    ),
  ).rejects.toThrow("Budget unavailable");
  expect(loaded).toBe(false);
});

test("cross-workspace count and actual-byte ceilings reject before destination writes", async () => {
  const { deps, reads, writes } = setup();
  const ids = Array.from(
    { length: 101 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  );
  await expect(
    transferClipboardAssets("user", "target", { sourceFile: "source", assetIds: ids }, deps),
  ).rejects.toThrow("too many images");
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
  deps.bytes = async (_actor, _org, _asset, limit, signal) => {
    expect(limit).toBe(2_000_000);
    expect(signal.aborted).toBe(false);
    return Buffer.alloc(2_000_001);
  };
  await expect(
    transferClipboardAssets("user", "target", { sourceFile: "source", assetIds: [first] }, deps),
  ).rejects.toThrow("copy allowance");
  expect(writes).toEqual([]);
});
