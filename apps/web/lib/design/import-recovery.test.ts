import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { mergeImport, requireImportSource } from "./merge-import";
import { PublicActionError } from "@/lib/security/public-error";

function fixture() {
  return {
    ...blankDesignDocument(),
    source: { project: "fixture", route: "/screen" },
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
        importKey: "fixture:/screen",
      },
    ],
  };
}

test("missing import metadata is actionable while new unsourced files remain supported", () => {
  const incoming = blankDesignDocument();
  expect(() => requireImportSource(incoming)).toThrow(PublicActionError);
  expect(() => mergeImport(blankDesignDocument(), incoming, "import")).toThrow(
    "Add source metadata with put_import_chunk",
  );
  expect(mergeImport(null, incoming, "import").nodes).toEqual([]);
  expect(requireImportSource(fixture())).toBe("fixture:/screen");
});

test("manual edit conflicts expose resolution choices and preserve the chosen content", () => {
  const current = { ...fixture(), editedNodeIds: ["frame"] };
  const incoming = fixture();
  incoming.nodes[0].name = "Agent frame";
  expect(() => mergeImport(current, incoming, "import")).toThrow(PublicActionError);
  expect(() => mergeImport(current, incoming, "import")).toThrow(
    "resolution keep_user, use_import, or duplicate",
  );
  expect(mergeImport(current, incoming, "import", "keep_user").nodes[0].name).toBe(
    current.nodes[0].name,
  );
  expect(mergeImport(current, incoming, "import", "use_import").nodes[0].name).toBe("Agent frame");
});

test("detaching a user layer returns a deliberate recovery error", () => {
  const current = fixture();
  current.nodes.push({
    ...buildDrawnNode("user-layer", "container", "frame", { x: 0, y: 0, width: 20, height: 20 }),
    importKey: "other:/screen",
  });
  const incoming = { ...fixture(), nodes: [] };
  expect(() => mergeImport(current, incoming, "import")).toThrow(PublicActionError);
  expect(() => mergeImport(current, incoming, "import")).toThrow(
    "Keep its source parent or move the layer first",
  );
});
