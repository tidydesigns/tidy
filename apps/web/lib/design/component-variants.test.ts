import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  componentVariantsSchema,
  parseDesignDocument,
  variantNodeChangesSchema,
} from "./document";
import { composeComponent, componentTreeSchema } from "./compose-component";
import { buttonExample } from "../mcp/design-tools";
import { createComponentInstance, removeLayers } from "./document-operations";
import { componentFamily, componentSubtreeIds, resolveVariantNodes } from "./component-variants";
import { syncComponentEdit } from "./component-sync";
import { componentExportDocument, exportComponent } from "./code-export";
import { layoutReport } from "./layout-diagnostics";
import { duplicateNodeTree } from "./duplicate-node";
import { duplicatePage, deletePage } from "./pages";
import { mergeImport } from "./merge-import";
import { copyLayers, pasteLayers, readDesignClipboard } from "./clipboard";
import { renameColorToken, removeColorToken } from "./tokens";

const fixture = () => composeComponent(componentTreeSchema.parse(buttonExample)).document;
const createId = (prefix: string) => {
  let i = 0;
  return () => `${prefix}-${i++}`;
};
test("variant descendants are independent of document order and remain confined to their family", () => {
  const document = fixture();
  const reversed = { ...document, nodes: [...document.nodes].reverse() };
  expect(parseDesignDocument(reversed)).toEqual(reversed);
  expect(componentSubtreeIds(reversed.nodes, "new-thread")).toEqual(
    new Set(["new-thread", "label"]),
  );
  const selected = new Map([["new-thread", "secondary"]]);
  expect(resolveVariantNodes(reversed.nodes, selected)).toEqual(
    resolveVariantNodes(document.nodes, selected).reverse(),
  );
  const outside = { ...document.nodes[1], id: "outside", parentId: null };
  document.nodes.push(outside);
  document.nodes[0].variants!.options.secondary.children = { outside: { text: "No" } };
  expect(() => parseDesignDocument(document)).toThrow("must belong");
});

function instance(variant = "secondary") {
  const result = createComponentInstance(fixture(), "new-thread", createId("copy"));
  return parseDesignDocument({
    ...result.document,
    nodes: syncComponentEdit(result.document.nodes, result.rootId, { variant }),
  });
}

test("named variants use one shared tree and retain sparse patches", () => {
  const document = fixture();
  expect(document.nodes).toHaveLength(2);
  expect(Object.keys(document.nodes[0].variants!.options)).toEqual([
    "primary",
    "secondary",
    "danger",
  ]);
  expect(variantNodeChangesSchema.parse({ style: { fill: "#ffffff" } })).toEqual({
    style: { fill: "#ffffff" },
  });
  expect(() => variantNodeChangesSchema.parse({ parentId: "other" })).toThrow();
  expect(() => variantNodeChangesSchema.parse({ semantics: { element: "a" } })).toThrow();
  expect(() =>
    componentVariantsSchema.parse({ default: "missing", options: { primary: {} } }),
  ).toThrow();
});

test("variant names and child references are validated against the component master", () => {
  const document = fixture();
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [{ ...document.nodes[0], variant: "unknown" }, document.nodes[1]],
    }),
  ).toThrow("unknown variant");
  document.nodes[0].variants!.options.secondary.children = { outside: { text: "No" } };
  expect(() => parseDesignDocument(document)).toThrow("must belong");
});

test("instances select palettes and state paints without baking them into the base tree", () => {
  const document = instance();
  const before = JSON.stringify(document);
  const rendered = resolveVariantNodes(document.nodes);
  expect(rendered.find((node) => node.id === "copy-0")).toMatchObject({
    style: { fill: "#eeeeec" },
    states: { hover: { fill: "#dddfdd" }, focus: { outlineWidth: 2 } },
    layout: "flex-row",
    align: "center",
    justify: "center",
  });
  expect(rendered.find((node) => node.id === "copy-1")?.style.color).toBe("#282a28");
  const danger = resolveVariantNodes(document.nodes, new Map([["copy-0", "danger"]]));
  expect(danger.find((node) => node.id === "copy-0")?.style.fill).toBe("#8f3030");
  expect(danger.find((node) => node.id === "copy-1")?.style.color).toBe("#eeeeec");
  expect(JSON.stringify(document)).toBe(before);
  expect(document.nodes.find((node) => node.id === "copy-0")?.variants).toBeUndefined();
});

test("master changes stay shared while instance overrides take precedence across variants", () => {
  const document = instance();
  let nodes = syncComponentEdit(document.nodes, "copy-1", {
    text: "Custom label",
    style: { color: "#123456" },
  });
  nodes = syncComponentEdit(nodes, "copy-0", { states: { hover: { fill: "#456789" } } });
  nodes = syncComponentEdit(nodes, "label", { text: "Updated shared label" });
  nodes = syncComponentEdit(nodes, "new-thread", {
    gap: 14,
    variants: {
      default: "danger",
      options: {
        ...document.nodes[0].variants!.options,
        secondary: {
          root: { style: { fill: "#abcdef" }, states: { hover: { fill: "#987654" } } },
          children: { label: { style: { color: "#000000" } } },
        },
      },
    },
  });
  const rendered = resolveVariantNodes(nodes);
  expect(rendered.find((node) => node.id === "copy-0")).toMatchObject({
    gap: 14,
    style: { fill: "#abcdef" },
    states: { hover: { fill: "#456789" } },
  });
  expect(rendered.find((node) => node.id === "copy-1")).toMatchObject({
    text: "Custom label",
    style: { color: "#123456" },
  });
  expect(rendered.find((node) => node.id === "new-thread")?.style.fill).toBe("#8f3030");
  expect(rendered.find((node) => node.id === "label")?.text).toBe("Updated shared label");
});

test("unselected variants cannot hide inaccessible controls or layout errors", () => {
  const document = fixture();
  document.nodes[0].variants!.options.broken = { root: { layout: "absolute" } };
  expect(layoutReport(document).issues).toContainEqual(
    expect.objectContaining({
      code: "absolute-control-content",
      variant: "broken",
      severity: "error",
    }),
  );
  expect(() => exportComponent(document, "new-thread", "Button")).toThrow("Variant broken");
  document.nodes[0].variants!.options.broken = { children: { label: { visible: false } } };
  expect(layoutReport(document).issues).toContainEqual(
    expect.objectContaining({ code: "missing-accessible-name", variant: "broken" }),
  );
});

test("exporting an instance retains all variants and its overrides with local child IDs", () => {
  const document = instance("danger");
  document.nodes = syncComponentEdit(document.nodes, "copy-1", {
    text: "My label",
    style: { color: "#112233" },
  });
  const standalone = componentExportDocument(document, "copy-0");
  expect(standalone.nodes).toHaveLength(2);
  expect(standalone.nodes[0].variants!.default).toBe("danger");
  expect(Object.keys(standalone.nodes[0].variants!.options.secondary.children!)).toEqual([
    "copy-1",
  ]);
  const secondary = resolveVariantNodes(standalone.nodes, new Map([["copy-0", "secondary"]]));
  expect(secondary[1]).toMatchObject({ text: "My label", style: { color: "#112233" } });
  const exported = exportComponent(document, "copy-0", "Button");
  expect(exported).toMatchObject({
    variants: ["primary", "secondary", "danger"],
    defaultVariant: "danger",
  });
  expect(exported.files[0].content).toContain(
    'export type ButtonVariant = "primary" | "secondary" | "danger"',
  );
  expect(exported.files[0].content).not.toContain('"componentSourceId"');
});

test("export gathers assets and fonts used only by an unselected variant", () => {
  const document = fixture();
  const asset = "00000000-0000-4000-8000-000000000001";
  document.nodes[0].variants!.options.danger.root = {
    style: {
      paints: [
        {
          id: "image",
          type: "image",
          assetId: asset,
          fit: "cover",
          positionX: 50,
          positionY: 50,
          opacity: 1,
          visible: true,
        },
      ],
    },
  };
  document.nodes[0].variants!.options.danger.children = {
    label: { style: { fontFamily: "Instrument Sans" } },
  };
  expect(() => exportComponent(document, "new-thread", "Button")).toThrow("missing");
  const exported = exportComponent(document, "new-thread", "Button", [
    { id: asset, mimeType: "image/png", base64: "aGVsbG8=" },
  ]);
  expect(exported.files.find((file) => file.path.endsWith(".png"))?.content).toBe("aGVsbG8=");
  expect(exported.files.find((file) => file.path.endsWith(".css"))?.content).toContain(
    "Instrument+Sans",
  );
});

test("duplicating nodes, pages and imports remaps variant child overrides", () => {
  const document = fixture();
  const duplicated = duplicateNodeTree(document, "new-thread", createId("duplicate"));
  const combined = parseDesignDocument({
    ...document,
    nodes: [...document.nodes, ...duplicated.nodes],
  });
  expect(
    resolveVariantNodes(combined.nodes, new Map([[duplicated.rootId, "secondary"]])).find(
      (node) => node.id === "duplicate-1",
    )?.style.color,
  ).toBe("#282a28");
  const page = duplicatePage(document, "page-1", "page-2", createId("page"));
  expect(
    Object.keys(
      page.nodes.find((node) => node.id === "page-0")!.variants!.options.secondary.children!,
    ),
  ).toEqual(["page-1"]);
  const imported = { ...document, source: { project: "test", route: "/button" } };
  const merged = mergeImport(imported, imported, "rerun", "duplicate");
  expect(
    Object.keys(
      merged.nodes.find((node) => node.id === "rerun-new-thread")!.variants!.options.secondary
        .children!,
    ),
  ).toEqual(["rerun-label"]);
});

test("clipboard preserves families and tokens, and detaches external instances with their appearance", () => {
  const document = instance();
  document.tokens = { surface: "#eeeeec" };
  document.nodes[0].variants!.options.secondary.root!.style!.fillToken = "surface";
  const payload = readDesignClipboard(copyLayers(document, ["new-thread"], "source"))!;
  const target = { ...blankDesignDocument(), tokens: { surface: "#ffffff" } };
  const pasted = pasteLayers(target, payload, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: createId("paste"),
  }).document;
  expect(pasted.nodes[0].variants!.options.secondary.root!.style!.fillToken).toBe("surface_2");
  expect(Object.keys(pasted.nodes[0].variants!.options.secondary.children!)).toEqual(["paste-1"]);
  const instancePayload = readDesignClipboard(copyLayers(document, ["copy-0"], "source"))!;
  const same = pasteLayers(document, instancePayload, {
    fileId: "source",
    pageId: "page-1",
    parentId: null,
    createId: createId("same"),
  }).document;
  expect(
    componentFamily(
      same.nodes,
      same.nodes.find((node) => node.id === "same-0")!,
    )?.master.id,
  ).toBe("new-thread");
  const detached = pasteLayers(blankDesignDocument(), instancePayload, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: createId("detached"),
  }).document;
  expect(detached.nodes[0]).toMatchObject({
    style: { fill: "#eeeeec" },
    states: { hover: { fill: "#dddfdd" } },
  });
  expect(detached.nodes[1].style.color).toBe("#282a28");
  expect(detached.nodes[0].variant).toBeUndefined();
});

test("token edits cover base, state and variant palettes", () => {
  const document = fixture();
  document.tokens = { accent: "#334455" };
  document.nodes[0].states!.hover!.fillToken = "accent";
  document.nodes[0].variants!.options.danger.root!.style!.fillToken = "accent";
  const renamed = renameColorToken(document, "accent", "brand");
  expect(renamed.nodes[0].states!.hover!.fillToken).toBe("brand");
  expect(renamed.nodes[0].variants!.options.danger.root!.style!.fillToken).toBe("brand");
  const removed = removeColorToken(renamed, "brand");
  expect(removed.nodes[0].states!.hover).toMatchObject({ fill: "#334455" });
  expect(removed.nodes[0].variants!.options.danger.root!.style).toMatchObject({ fill: "#334455" });
});

test("deleting a master detaches instances with their selected appearance", () => {
  const document = instance();
  const removed = removeLayers(document, ["new-thread"]);
  expect(removed.nodes).toHaveLength(2);
  expect(removed.nodes[0].style.fill).toBe("#eeeeec");
  expect(removed.nodes[1].style.color).toBe("#282a28");
  expect(removed.nodes[0].variant).toBeUndefined();
  const acrossPages = {
    ...document,
    pages: [
      { id: "page-1", name: "Master" },
      { id: "page-2", name: "Instances" },
    ],
    nodes: document.nodes.map((node) => (node.instanceOf ? { ...node, pageId: "page-2" } : node)),
  };
  expect(parseDesignDocument(deletePage(acrossPages, "page-1")).nodes[0].style.fill).toBe(
    "#eeeeec",
  );
});

test("instances without a selection follow future default changes, independently of the master's preview", () => {
  const document = fixture();
  document.nodes[0].variant = "secondary";
  const copy = createComponentInstance(document, "new-thread", createId("following"));
  expect(copy.document.nodes.find((node) => node.id === copy.rootId)?.variant).toBeUndefined();
  const nodes = syncComponentEdit(copy.document.nodes, "new-thread", {
    variants: { ...document.nodes[0].variants!, default: "danger" },
  });
  expect(resolveVariantNodes(nodes).find((node) => node.id === copy.rootId)?.style.fill).toBe(
    "#8f3030",
  );
});

test("variant paint resets preserve explicit instance paint stacks", () => {
  const document = instance();
  const paints = [
    { id: "custom", type: "solid" as const, color: "#223344", opacity: 1, visible: true },
  ];
  const nodes = syncComponentEdit(document.nodes, "copy-0", { style: { paints } });
  expect(resolveVariantNodes(nodes).find((node) => node.id === "copy-0")?.style.paints).toEqual(
    paints,
  );
  const standalone = componentExportDocument({ ...document, nodes }, "copy-0");
  expect(
    resolveVariantNodes(standalone.nodes, new Map([["copy-0", "danger"]]))[0].style.paints,
  ).toEqual(paints);
});

test("custom interaction colours take precedence over variant token bindings", () => {
  const document = instance();
  document.tokens.brand = "#556677";
  document.nodes[0].variants!.options.secondary.root!.states!.hover!.fillToken = "brand";
  const nodes = syncComponentEdit(document.nodes, "copy-0", {
    states: { hover: { fill: "#223344" } },
  });
  expect(
    resolveVariantNodes(nodes).find((node) => node.id === "copy-0")?.states?.hover,
  ).toMatchObject({ fill: "#223344" });
  expect(
    resolveVariantNodes(nodes).find((node) => node.id === "copy-0")?.states?.hover?.fillToken,
  ).toBeUndefined();
  const standalone = componentExportDocument({ ...document, nodes }, "copy-0");
  expect(resolveVariantNodes(standalone.nodes)[0].states?.hover?.fillToken).toBeUndefined();
});

test("copying a child out of a variant retains its displayed colour", () => {
  const document = fixture();
  document.nodes[0].variant = "secondary";
  const payload = readDesignClipboard(copyLayers(document, ["label"], "source"))!;
  const pasted = pasteLayers(blankDesignDocument(), payload, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: createId("child"),
  });
  expect(pasted.document.nodes[0].style.color).toBe("#282a28");
});
