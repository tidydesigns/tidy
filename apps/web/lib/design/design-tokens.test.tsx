import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  blankDesignDocument,
  buildDrawnNode,
  designNodeChangesSchema,
  parseDesignDocument,
  type DesignDocument,
} from "./document";
import { resolveNodeTokens, resolvedColorTokens, resolvedDocumentNodes } from "./design-tokens";
import { renameDesignToken, removeDesignToken } from "./tokens";
import { createComponentInstance, makeComponent } from "./document-operations";
import { resetInstance } from "./component-instance";
import { editLayers } from "./edit-document";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import {
  copyLayers,
  copyProperties,
  pasteLayers,
  pasteProperties,
  readDesignClipboard,
} from "./clipboard";
import { mergeImport } from "./merge-import";
import { resolveVariantNodes } from "./component-variants";
import { componentExportDocument } from "./code-export";
import { nodeStyle } from "./node-style";
import { TidyDesign } from "@tidy/design-renderer/design";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { shared } from "@/app/files/[uid]/inspector-controls";

function fixture(): DesignDocument {
  return parseDesignDocument({
    ...blankDesignDocument(),
    tokens: { brand: "#123456" },
    designTokens: {
      rounded: { type: "radius", value: 12 },
      inset: { type: "spacing", value: 16 },
      card: { type: "dimension", value: 280 },
      small: { type: "dimension", value: 20 },
      body: {
        type: "typography",
        value: {
          fontFamily: "system-ui",
          fontSize: 18,
          fontWeight: 500,
          lineHeightMode: "percent",
          lineHeight: 1.4,
        },
      },
      corner: { type: "radius", alias: "rounded" },
      tint: { type: "color", alias: "brand" },
    },
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 500, height: 400 }),
        layout: "flex-column",
        tokenBindings: { padding: "inset", gap: "inset", radius: "corner" },
        style: { fillToken: "tint" },
      },
      {
        ...buildDrawnNode("card", "container", "frame", { x: 0, y: 0, width: 100, height: 60 }),
        tokenBindings: { width: "card", radius: "corner" },
        style: { fill: "#ffffff" },
      },
      {
        ...buildDrawnNode("label", "text", "frame", { x: 0, y: 0, width: 100, height: 40 }),
        text: "Bound text",
        tokenBindings: { textStyle: "body", fontSize: "small" },
      },
      buildDrawnNode("untouched", "container", "frame", { x: 0, y: 0, width: 40, height: 40 }),
    ],
  });
}
test("typed tokens and aliases validate dependencies, types and every bound property range", () => {
  const doc = fixture();
  expect(() =>
    parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, rounded: { type: "radius", alias: "corner" } },
    }),
  ).toThrow("cycle");
  expect(() =>
    parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, corner: { type: "radius", alias: "inset" } },
    }),
  ).toThrow("different type");
  expect(() =>
    parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, corner: { type: "radius", alias: "missing" } },
    }),
  ).toThrow("not found");
  expect(() =>
    parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, brand: { type: "color", value: "#ffffff" } },
    }),
  ).toThrow("Duplicate");
  expect(() =>
    parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, card: { type: "dimension", value: 0 } },
    }),
  ).toThrow();
  expect(() =>
    parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, inset: { type: "spacing", value: -1 } },
    }),
  ).toThrow();
  expect(() =>
    parseDesignDocument({
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === "card" ? { ...node, tokenBindings: { radius: "inset" } } : node,
      ),
    }),
  ).toThrow("radius token");
  expect(() =>
    parseDesignDocument({
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === "card" ? { ...node, tokenBindings: { textStyle: "body" } } : node,
      ),
    }),
  ).toThrow("text layer");
  expect(parseDesignDocument(blankDesignDocument()).designTokens).toBeUndefined();
});
test("token resolution updates only affected node identities and preserves mixed selection feedback", () => {
  const doc = fixture(),
    before = doc.nodes.map((node) => resolveNodeTokens(node, doc));
  const updated: DesignDocument = {
    ...doc,
    designTokens: { ...doc.designTokens, rounded: { type: "radius", value: 24 } },
  };
  const after = doc.nodes.map((node) => resolveNodeTokens(node, updated));
  expect(after[0]).not.toBe(before[0]);
  expect(after[1].style.radius).toBe(24);
  expect(after[2]).toBe(before[2]);
  expect(after[3]).toBe(doc.nodes[3]);
  expect(shared([after[0], after[1]], (node) => node.tokenBindings?.radius)).toBe("corner");
  expect(shared([after[1], after[3]], (node) => node.tokenBindings?.radius ?? "")).toBeUndefined();
  expect(nodeStyle(after[0], "absolute", resolvedColorTokens(updated))).toMatchObject({
    paddingTop: 16,
    rowGap: 16,
    borderRadius: "24px 24px 24px 24px",
    background: "#123456",
  });
  expect(nodeStyle(after[1], "flex-column", {})).toMatchObject({
    width: 280,
    borderRadius: "24px 24px 24px 24px",
  });
  expect(after[2].style).toMatchObject({ fontSize: 20, fontWeight: 500, lineHeight: 1.4 });
});
test("rename and delete remap aliases and materialize current values without losing other bindings", () => {
  const doc = fixture();
  const renamed = renameDesignToken(doc, "rounded", "pill");
  expect(renamed.designTokens!.corner).toEqual({ type: "radius", alias: "pill" });
  const removed = removeDesignToken(renamed, "pill");
  expect(removed.designTokens!.corner).toEqual({ type: "radius", value: 12 });
  expect(removed.nodes[1].tokenBindings!.radius).toBe("corner");
  const detached = removeDesignToken(removed, "corner");
  expect(detached.nodes[1].style.radius).toBe(12);
  expect(detached.nodes[1].tokenBindings).toMatchObject({ radius: null, width: "card" });
  expect(resolveNodeTokens(detached.nodes[1], detached).box.width).toBe(280);
  const color = renameDesignToken(detached, "brand", "accent");
  expect(color.designTokens!.tint).toEqual({ type: "color", alias: "accent" });
  const text = removeDesignToken(color, "body");
  expect(text.nodes[2].style).toMatchObject({
    fontFamily: "system-ui",
    fontWeight: 500,
    fontSize: 20,
  });
  expect(text.nodes[2].tokenBindings).toMatchObject({ textStyle: null, fontSize: "small" });
  expect(applyDocumentPatch(detached, invertPatch(diffDocument(removed, detached)), true)).toEqual(
    removed,
  );
});
test("literal edits detach their binding while preserving latest resolved typography and undo", () => {
  const original = fixture();
  const before = parseDesignDocument({
    ...original,
    designTokens: {
      ...original.designTokens,
      body: { type: "typography", value: { fontSize: 24, fontWeight: 600, fontFamily: "serif" } },
    },
  });
  const after = editLayers(before, ["label"], { style: { fontWeight: 700 } });
  expect(after.nodes[2].tokenBindings).toMatchObject({ textStyle: null, fontSize: "small" });
  expect(after.nodes[2].style).toMatchObject({
    fontFamily: "serif",
    fontWeight: 700,
    fontSize: 20,
  });
  expect(editLayers(before, ["card"], { name: "Renamed" }).nodes[1].box).toEqual(
    before.nodes[1].box,
  );
  const dimensions = editLayers(before, ["card"], { box: { width: 320 } });
  expect(dimensions.nodes[1].tokenBindings!.width).toBeNull();
  expect(dimensions.nodes[1].tokenBindings!.radius).toBe("corner");
  expect(applyDocumentPatch(after, invertPatch(diffDocument(before, after)), true)).toEqual(before);
  const mcp = editLayers(
    before,
    ["card"],
    designNodeChangesSchema.parse({ tokenBindings: { width: "small" } }),
  );
  expect(resolveNodeTokens(mcp.nodes[1], mcp).box.width).toBe(20);
  const component = parseDesignDocument({
    ...before,
    nodes: [
      { ...before.nodes[0], isComponent: true },
      ...before.nodes.slice(1),
      { ...before.nodes[2], id: "label-copy", instanceOf: "frame", componentSourceId: "label" },
    ],
  });
  const propagated = editLayers(component, ["label"], { style: { fontWeight: 800 } });
  expect(propagated.nodes[4].style).toMatchObject({
    fontFamily: "serif",
    fontWeight: 800,
    fontSize: 20,
  });
  expect(propagated.nodes[4].tokenBindings!.textStyle).toBeNull();
});
test("component and variant token bindings synchronize and respect instance literal overrides", () => {
  const doc = fixture();
  doc.nodes[0].isComponent = true;
  doc.nodes[0].variants = {
    default: "standard",
    options: {
      standard: {},
      compact: { children: { card: { tokenBindings: { width: "small" } } } },
    },
  };
  doc.nodes.push({
    ...doc.nodes[1],
    id: "instance",
    parentId: "frame",
    instanceOf: "frame",
    componentSourceId: "card",
    instanceOverrides: ["style.radius"],
    style: { radius: 3 },
    tokenBindings: { width: "card", radius: null },
  });
  const changed = editLayers(doc, ["card"], {
    tokenBindings: { width: "small", radius: "rounded" },
  });
  expect(changed.nodes[4].tokenBindings).toMatchObject({ width: "small", radius: null });
  expect(resolveNodeTokens(changed.nodes[4], changed).style.radius).toBe(3);
  const compact = resolveVariantNodes(changed.nodes, new Map([["frame", "compact"]]));
  expect(resolveNodeTokens(compact[1], changed).box.width).toBe(20);
  const removed = removeDesignToken(changed, "small");
  expect(removed.nodes[0].variants!.options.compact.children!.card).toMatchObject({
    tokenBindings: { width: null },
    box: { width: 20 },
  });
  expect(parseDesignDocument(JSON.parse(JSON.stringify(removed)))).toEqual(removed);
});
test("clipboard and appearance paste remap alias graphs and token conflicts across files", () => {
  const source = fixture();
  const target = parseDesignDocument({
    ...blankDesignDocument(),
    tokens: { brand: "#ffffff" },
    designTokens: {
      rounded: { type: "radius", value: 1 },
      inset: { type: "spacing", value: 4 },
      card: { type: "dimension", value: 99 },
    },
    nodes: [buildDrawnNode("target", "artboard", null, { x: 0, y: 0, width: 600, height: 500 })],
  });
  const payload = readDesignClipboard(copyLayers(source, ["frame"], "source"))!;
  const pasted = pasteLayers(target, payload, {
    fileId: "target-file",
    pageId: "page-1",
    parentId: null,
    inPlace: true,
    createId: () => crypto.randomUUID(),
  });
  const card = pasted.document.nodes.find((node) => node.name === "Rectangle")!;
  expect(resolveNodeTokens(card, pasted.document).box.width).toBe(280);
  expect(resolveNodeTokens(card, pasted.document).style.radius).toBe(12);
  expect(pasted.document.designTokens!.corner).toEqual({ type: "radius", alias: "rounded_2" });
  expect(pasted.document.tokens.brand).toBe("#ffffff");
  expect(pasted.document.tokens.brand_2).toBe("#123456");
  const appearance = pasteProperties(
    pasted.document,
    readDesignClipboard(copyProperties(source.nodes[1], source, "source"))!,
    ["target"],
  );
  expect(resolveNodeTokens(appearance.nodes[0], appearance).style.radius).toBe(12);
  expect(appearance.nodes[0].box.width).toBe(600);
});
test("reimport preserves edited bindings and remaps imported definitions without changing existing layers", () => {
  const current = fixture();
  current.source = { project: "test", route: "/" };
  current.nodes = current.nodes.map((node) => ({
    ...node,
    importKey: "test:/",
    sourceKey: node.id,
  }));
  current.editedNodeIds = ["card"];
  const incoming = parseDesignDocument({
    ...current,
    editedNodeIds: [],
    designTokens: { ...current.designTokens, card: { type: "dimension", value: 340 } },
  });
  const kept = mergeImport(current, incoming, "run", "keep_user");
  expect(resolveNodeTokens(kept.nodes[1], kept).box.width).toBe(280);
  const accepted = mergeImport(current, incoming, "run", "use_import");
  expect(resolveNodeTokens(accepted.nodes[1], accepted).box.width).toBe(340);
  expect(accepted.designTokens!.card).toEqual({ type: "dimension", value: 280 });
  expect(accepted.designTokens!.card_2).toEqual({ type: "dimension", value: 340 });
});
test("schema patches, shared previews, reviews and code exports retain live token bindings", () => {
  const doc = fixture(),
    next = parseDesignDocument({
      ...doc,
      designTokens: { ...doc.designTokens, card: { type: "dimension", value: 320 } },
    });
  const applied = applyDocumentPatch(doc, diffDocument(doc, next));
  expect(applyDocumentPatch(applied, invertPatch(diffDocument(doc, next)), true)).toEqual(doc);
  const preview = renderToStaticMarkup(
    createElement(TidyDesign, { document: applied, rootId: "frame", assets: {} }),
  );
  expect(preview).toContain("width:320px");
  expect(preview).toContain("font-size:20px");
  const review = renderToStaticMarkup(
    createElement(DesignSnapshot, {
      content: applied,
      frameId: "frame",
      reviewId: "local",
      selectedNode: null,
      onSelect: () => {},
    }),
  );
  expect(review).toContain("width:320px");
  expect(review).toContain("padding-top:16px");
  const thumbnail = renderToStaticMarkup(createElement(DocumentPreview, { content: applied }));
  expect(thumbnail).toContain("width:320px");
  expect(thumbnail).toContain("font-size:20px");
  const exported = componentExportDocument(applied, "frame");
  expect(exported.designTokens).toEqual(applied.designTokens);
  expect(exported.nodes[1].tokenBindings).toEqual(applied.nodes[1].tokenBindings);
  expect(
    renderToStaticMarkup(
      createElement(TidyDesign, { document: exported, rootId: "frame", assets: {} }),
    ),
  ).toContain("width:320px");
});

test("a variant literal typography override retains the other inherited text-style values", () => {
  const document = fixture();
  document.nodes[0].isComponent = true;
  document.nodes[0].variants = {
    default: "bold",
    options: { bold: { children: { label: { style: { fontWeight: 800 } } } } },
  };
  const validated = parseDesignDocument(document);
  const resolved = resolvedDocumentNodes(validated);
  expect(resolved[2].style).toMatchObject({
    fontFamily: "system-ui",
    fontWeight: 800,
    lineHeight: 1.4,
    fontSize: 20,
  });
  expect(resolved[2].tokenBindings!.textStyle).toBeNull();
  expect(resolved[2].tokenBindings!.fontSize).toBe("small");
  expect(
    renderToStaticMarkup(
      createElement(TidyDesign, { document: validated, rootId: "frame", assets: {} }),
    ),
  ).toContain("font-size:20px");
});

test("linked instance literal detachment survives master updates and reset restores the live token", () => {
  const initial = fixture();
  initial.nodes[0].type = "container";
  const master = makeComponent(initial, "frame");
  let nextId = 0;
  const instance = createComponentInstance(master, "frame", () => `instance-${nextId++}`);
  const linked = instance.document;
  const child = linked.nodes.find(
    (node) => node.instanceOf === "frame" && node.componentSourceId === "card",
  )!;
  const overridden = editLayers(linked, [child.id], { box: { width: 350 } });
  const updated = editLayers(overridden, ["card"], { tokenBindings: { width: "small" } });
  const rendered = resolvedDocumentNodes(updated).find((node) => node.id === child.id)!;
  expect(rendered.box.width).toBe(350);
  expect(rendered.tokenBindings?.width).toBeNull();
  const reset = resetInstance(updated, instance.rootId);
  expect(resolvedDocumentNodes(reset).find((node) => node.id === child.id)!.box.width).toBe(20);
  const transported = applyDocumentPatch(linked, diffDocument(linked, updated));
  expect(resolvedDocumentNodes(transported).find((node) => node.id === child.id)!.box.width).toBe(
    350,
  );
});
