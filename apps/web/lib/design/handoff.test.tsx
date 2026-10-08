import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignNode,
} from "./document";
import { layerHandoff, handoffCss, handoffFacts, styleDeclarations } from "./handoff";
import { createComponentInstance, makeComponent } from "./document-operations";
import { SelectionInspector } from "@/app/files/[uid]/selection-inspector";

const box = { x: 0, y: 0, width: 300, height: 100 };
function fixture() {
  const frame: DesignNode = {
    ...buildDrawnNode("frame", "artboard", null, { ...box, width: 400, height: 500 }),
    layout: "flex-column",
    padding: 24,
    gap: 16,
  };
  const master: DesignNode = {
    ...buildDrawnNode("master", "container", "frame", box),
    name: "Card",
    layout: "flex-row",
    padding: 20,
    gap: 18,
    widthMode: "fill",
    sourcePath: "src/card.tsx",
    importKey: "site:/",
    sourceKey: "card",
    style: { fill: "#000000", fillToken: "ink" },
    responsiveBreakpoints: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        frameMaxWidth: 500,
        layout: "flex-column",
        padding: 8,
        gap: 6,
      },
    ],
  };
  const text: DesignNode = {
    ...buildDrawnNode("label", "text", "master", { ...box, width: 100, height: 30 }),
    style: {
      colorToken: "ink",
      color: "#111111",
      fontSize: 18,
      fontWeight: 600,
      lineHeight: 1.5,
      fontFamily: "system-ui",
    },
    text: "Label",
  };
  const component = makeComponent(
    {
      ...blankDesignDocument(),
      tokens: { ink: "#222222", paper: "#eeeeee" },
      source: { project: "site", route: "/", revision: "abc" },
      nodes: [frame, master, text],
    },
    "master",
  );
  component.nodes.find((node) => node.id === "master")!.variants = {
    default: "primary",
    options: {
      primary: {},
      secondary: {
        root: { style: { fillToken: "paper", fill: "#ffffff" } },
        children: { label: { style: { fontSize: 24 } } },
      },
    },
  };
  let counter = 0;
  const instance = createComponentInstance(component, "master", () => `copy-${counter++}`);
  instance.document.nodes.find((node) => node.id === "copy-0")!.variant = "secondary";
  return parseDesignDocument(instance.document);
}

test("handoff resolves component variants, child overrides, responsive layout and tokens without changing the document", () => {
  const document = fixture();
  const before = JSON.stringify(document);
  const card = layerHandoff(document, "copy-0")!;
  expect(card.component).toEqual({ name: "Card", variant: "secondary" });
  expect(card.style).toMatchObject({
    background: "#eeeeee",
    flexDirection: "column",
    paddingTop: 8,
    rowGap: 6,
  });
  expect(card.bindings).toContainEqual({
    property: "Fill 1",
    name: "paper",
    value: "#eeeeee",
    missing: false,
  });
  expect(card.breakpoints).toEqual([500]);
  expect(layerHandoff(document, "copy-1")!.style.fontSize).toBe(24);
  expect(card.source).toContainEqual(["Source path", "src/card.tsx"]);
  expect(card.source).toContainEqual(["Project", "site"]);
  expect(JSON.stringify(document)).toBe(before);
  const wide = {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === "frame" ? { ...node, box: { ...node.box, width: 800 } } : node,
    ),
  };
  expect(layerHandoff(wide, "copy-0")!.style).toMatchObject({
    flexDirection: "row",
    paddingTop: 20,
    rowGap: 18,
  });
});

test("handoff does not assign the latest import's source metadata to older layers", () => {
  const document = fixture();
  const laterImport = {
    ...document,
    source: { project: "other-site", route: "/new", revision: "later" },
  };
  const older = layerHandoff(laterImport, "master")!;
  expect(older.source).toContainEqual(["Source path", "src/card.tsx"]);
  expect(older.source).toContainEqual(["Import", "site:/"]);
  expect(older.source.some(([label]) => ["Project", "Route", "Revision"].includes(label))).toBe(
    false,
  );
  const duplicate = {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === "master" ? { ...node, importKey: "site:/#duplicate" } : node,
    ),
  };
  expect(layerHandoff(laterImport, "copy-0")!.source).toEqual(older.source);
  expect(layerHandoff(duplicate, "master")!.source).toContainEqual(["Revision", "abc"]);
});

test("CSS preserves renderer units and excludes editor selection decoration", () => {
  const result = handoffCss({
    width: "max-content",
    fontSize: 16,
    lineHeight: 1.5,
    fontWeight: 600,
    opacity: 0.5,
    zIndex: -1,
    letterSpacing: -0.2,
    transform: "rotate(37deg)",
    WebkitLineClamp: 2,
  });
  for (const expected of [
    "width: max-content",
    "font-size: 16px",
    "line-height: 1.5;",
    "font-weight: 600;",
    "opacity: 0.5;",
    "z-index: -1;",
    "letter-spacing: -0.2px",
    "-webkit-line-clamp: 2;",
  ])
    expect(result).toContain(expected);
  expect(result).not.toContain("primary-orange");
  expect(styleDeclarations({ color: undefined, padding: 0 })).toEqual([["padding", "0"]]);
});

test("asset and missing-token provenance includes image fills and gradient stops", () => {
  const asset = "00000000-0000-4000-8000-000000000002";
  const node: DesignNode = {
    ...buildDrawnNode("image", "container", null, box),
    style: {
      paints: [
        {
          id: "photo",
          type: "image",
          assetId: asset,
          fit: "cover",
          positionX: 50,
          positionY: 50,
          opacity: 1,
          visible: true,
        },
        {
          id: "gradient",
          type: "linear",
          angle: 90,
          opacity: 1,
          visible: true,
          stops: [
            { id: "start", position: 0, color: "#ff0000", token: "missing" },
            { id: "end", position: 1, color: "#ffffff" },
          ],
        },
      ],
    },
  };
  const model = layerHandoff(
    parseDesignDocument({ ...blankDesignDocument(), nodes: [node] }),
    node.id,
  )!;
  expect(model.assets).toEqual([asset]);
  expect(model.bindings).toContainEqual({
    property: "Fill 2, stop 1",
    name: "missing",
    value: "#ff0000",
    missing: true,
  });
  expect(handoffFacts(node, model.style, { ...box, width: 184.25, height: 73.5 })).toContainEqual([
    "Size",
    "184.25px × 73.5px",
  ]);
});

test("viewer inspection provides CSS and provenance with no editing fields", () => {
  const document = fixture();
  const selected = document.nodes.filter((node) => node.id === "copy-0");
  const html = renderToStaticMarkup(
    <SelectionInspector
      selected={selected}
      document={document}
      readOnly
      onPatch={() => {
        throw new Error("read-only");
      }}
      onDocument={() => {
        throw new Error("read-only");
      }}
      onExport={() => {}}
      onReplaceImage={() => {}}
      onPrototype={() => {}}
      onAlign={() => {}}
      onDistribute={() => {}}
      onGroup={() => {}}
    />,
  );
  expect(html).toContain("Copy CSS");
  expect(html).toContain("Generated CSS");
  expect(html).toContain("secondary");
  expect(html).toContain("Imported source");
  expect(html.match(/<input/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Export scale"');
  expect(html).not.toContain("<fieldset");
});
