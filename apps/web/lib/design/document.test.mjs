import { describe, expect, test } from "bun:test";
import { buildLoginDocument } from "./examples/login";
import {
  blankDesignDocument,
  buildDrawnNode,
  documentAssetIds,
  parseDesignDocument,
} from "./document";
import { applyDocumentPatch } from "./document-patch";
import { componentExportDocument } from "./code-export";
import { nodeStyle } from "./node-style";

const logoId = "00000000-0000-4000-8000-000000000001";

describe("editable design document", () => {
  test("documents with more than 5000 image fill assets remain editable and exportable with MIME metadata", () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      nodes: Array.from({ length: 251 }, (_, index) => ({
        ...buildDrawnNode(`node-${index}`, "container", null, {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        }),
        style: {
          paints: Array.from({ length: 20 }, (_, paint) => ({
            id: `paint-${paint}`,
            type: "image",
            assetId: crypto.randomUUID(),
          })),
        },
      })),
    });
    const ids = documentAssetIds(document);
    expect(ids).toHaveLength(5020);
    const enriched = parseDesignDocument({
      ...document,
      assetMimeTypes: Object.fromEntries(ids.map((id) => [id, "image/png"])),
    });
    const edited = applyDocumentPatch(enriched, [
      {
        collection: "nodes",
        id: "node-0",
        path: ["name"],
        before: { exists: true, value: "Rectangle" },
        after: { exists: true, value: "Renamed" },
      },
    ]);
    expect(edited.nodes[0].name).toBe("Renamed");
    expect(Object.keys(edited.assetMimeTypes)).toHaveLength(5020);
    expect(documentAssetIds(componentExportDocument(edited, "node-0"))).toHaveLength(20);
  });
  test("new files start with an empty canvas", () => {
    const document = parseDesignDocument(blankDesignDocument());
    expect(document.nodes).toHaveLength(0);
    expect(document.legacyConverted).toBe(true);
  });
  test("documents saved before legacy conversion remain eligible for conversion", () => {
    const olderDocument = { ...blankDesignDocument() };
    delete olderDocument.legacyConverted;
    expect(parseDesignDocument(olderDocument).legacyConverted).toBe(false);
  });
  test("older documents load with an empty list of deleted imported layers", () => {
    const olderDocument = { ...blankDesignDocument() };
    delete olderDocument.deletedSourceKeys;
    expect(parseDesignDocument(olderDocument).deletedSourceKeys).toEqual([]);
  });
  test("rectangles and text can live directly on the canvas", () => {
    const document = blankDesignDocument();
    const rectangle = {
      id: "rectangle-1",
      parentId: null,
      name: "Rectangle",
      type: "container",
      box: { x: 1700, y: 120, width: 200, height: 100 },
      style: { fill: "#dedede" },
      visible: true,
      locked: false,
      layout: "absolute",
    };
    const text = {
      id: "text-1",
      parentId: null,
      name: "Text",
      type: "text",
      box: { x: 1700, y: 250, width: 200, height: 48 },
      style: { color: "#1e1e1e" },
      text: "Outside frame",
      visible: true,
      locked: false,
      layout: "absolute",
    };
    const parsed = parseDesignDocument({
      ...document,
      nodes: [...document.nodes, rectangle, text],
    });
    expect(parsed.nodes.filter((node) => node.parentId === null)).toHaveLength(2);
    expect(() =>
      parseDesignDocument({
        ...document,
        nodes: [...document.nodes, { ...text, parentId: "missing" }],
      }),
    ).toThrow("has no parent");
    expect(
      parseDesignDocument({
        ...document,
        nodes: [...document.nodes, { ...rectangle, box: { ...rectangle.box, y: -180 } }],
      }).nodes[0].box.y,
    ).toBe(-180);
    expect(
      parseDesignDocument({ ...document, nodes: [rectangle, text] }).nodes.every(
        (node) => node.type !== "artboard",
      ),
    ).toBe(true);
  });
  test("the imported login screen is a valid editable tree with both viewports", () => {
    const document = parseDesignDocument(buildLoginDocument());
    expect(document.nodes.filter((node) => node.type === "artboard")).toHaveLength(2);
    expect(
      document.nodes.filter((node) => node.type === "text").map((node) => node.text),
    ).toContain("Welcome back.");
    expect(
      document.nodes
        .filter((node) => node.id.endsWith("-logo"))
        .map((node) => ({
          text: node.text,
          font: node.style.fontFamily,
          spacing: node.style.letterSpacing,
        })),
    ).toEqual([
      { text: "Tidy", font: "var(--font-instrument-serif)", spacing: -0.68 },
      { text: "Tidy", font: "var(--font-instrument-serif)", spacing: -0.68 },
    ]);
    expect(document.nodes.every((node) => node.sourceKey && node.sourcePath)).toBe(true);
  });
  test("text geometry supports paragraph spacing, vertical alignment and all line-height units without changing legacy text", () => {
    const original = buildLoginDocument(logoId);
    const legacy = parseDesignDocument(original).nodes.find(
      (node) => node.id === "desktop-heading",
    );
    expect(nodeStyle(legacy, "absolute", {}).lineHeight).toBe(legacy.style.lineHeight);
    const styles = [
      { lineHeightMode: "auto", paragraphSpacing: 12, textVerticalAlign: "bottom" },
      {
        lineHeightMode: "percent",
        lineHeight: 1.4,
        paragraphSpacing: 12,
        textVerticalAlign: "bottom",
      },
      { lineHeightMode: "px", lineHeightPx: 42, paragraphSpacing: 12, textVerticalAlign: "bottom" },
    ];
    const parsed = styles.map((style) =>
      parseDesignDocument({
        ...original,
        nodes: original.nodes.map((node) =>
          node.id === "desktop-heading"
            ? { ...node, text: "First\nSecond", style: { ...node.style, ...style } }
            : node,
        ),
      }).nodes.find((node) => node.id === "desktop-heading"),
    );
    expect(parsed.map((node) => nodeStyle(node, "absolute", {}).lineHeight)).toEqual([
      "normal",
      1.4,
      "42px",
    ]);
    expect(
      parsed.every((node) => nodeStyle(node, "absolute", {}).justifyContent === "flex-end"),
    ).toBe(true);
    expect(parsed.every((node) => node.style.paragraphSpacing === 12)).toBe(true);
  });

  test("rejects duplicate IDs and cycles before publish", () => {
    const document = buildLoginDocument(logoId);
    expect(() =>
      parseDesignDocument({ ...document, nodes: [...document.nodes, document.nodes[0]] }),
    ).toThrow("Duplicate node ID");
    const nodes = document.nodes.map((node) =>
      node.id === "desktop-panel" ? { ...node, parentId: "desktop-panel" } : node,
    );
    expect(() => parseDesignDocument({ ...document, nodes })).toThrow("cycle");
  });

  test("prototype links target frames and color tokens parse", () => {
    const document = buildLoginDocument(logoId);
    const nodes = document.nodes.map((node) =>
      node.id === "desktop-heading"
        ? { ...node, linkTo: "mobile-screen", style: { ...node.style, colorToken: "brand" } }
        : node,
    );
    const valid = parseDesignDocument({ ...document, tokens: { brand: "#ff5d00" }, nodes });
    expect(valid.tokens.brand).toBe("#ff5d00");
    expect(() =>
      parseDesignDocument({
        ...valid,
        nodes: valid.nodes.map((node) =>
          node.id === "desktop-heading" ? { ...node, linkTo: "missing" } : node,
        ),
      }),
    ).toThrow("missing frame");
  });

  test("rejects unsupported style properties and invalid asset IDs", () => {
    const document = buildLoginDocument(logoId);
    const nodes = document.nodes.map((node) =>
      node.id === "desktop-heading"
        ? { ...node, style: { ...node.style, cursor: "url(javascript:alert(1))" } }
        : node,
    );
    expect(() => parseDesignDocument({ ...document, nodes })).toThrow();
    const missingAsset = document.nodes.map((node) =>
      node.id === "desktop-crop-fixture" ? { ...node, assetId: undefined } : node,
    );
    expect(() => parseDesignDocument({ ...document, nodes: missingAsset })).toThrow(
      "needs an asset",
    );
  });
});
