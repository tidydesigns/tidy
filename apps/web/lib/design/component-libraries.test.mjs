import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { createComponentInstance, removeLayers } from "./document-operations";
import { componentExportDocument } from "./code-export";
import { resolvedDocumentNodes } from "./design-tokens";
import { editLayers } from "./edit-document";
import {
  exposeComponentProperty,
  setComponentProperty,
  propertyTarget,
} from "./component-properties";
import { libraryPayload, importLibraryComponent, markLibraryStatus } from "./component-libraries";
import {
  createReusableStyle,
  applyReusableStyle,
  updateReusableStyle,
  removeReusableStyle,
} from "./reusable-styles";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { copyLayers, pasteLayers, readDesignClipboard } from "./clipboard";
import { duplicateNodeTree } from "./duplicate-node";
const uid = "00000000-0000-4000-8000-000000000037";
const source = () =>
  parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("component", "container", null, { x: 0, y: 0, width: 160, height: 80 }),
        isComponent: true,
        name: "Button",
        style: { fill: "#123456" },
      },
      {
        ...buildDrawnNode("label", "text", "component", { x: 10, y: 10, width: 120, height: 30 }),
        text: "Original",
        style: { fontSize: 16, color: "#ffffff" },
      },
    ],
  });
let serial = 0;
const id = () => `local-${++serial}`;
test("exposed property controls edit mapped instance children and preserve variant overrides", () => {
  let doc = exposeComponentProperty(source(), "component", "label", {
    name: "Label",
    targetId: "label",
    property: "text",
  });
  const created = createComponentInstance(doc, "component", id);
  doc = created.document;
  const binding = doc.nodes[0].componentProperties.label;
  expect(
    propertyTarget(
      doc,
      doc.nodes.find((n) => n.id === created.rootId),
      binding,
    ).componentSourceId,
  ).toBe("label");
  const changed = setComponentProperty(doc, created.rootId, "label", "Custom");
  const target = propertyTarget(
    changed,
    changed.nodes.find((n) => n.id === created.rootId),
    binding,
  );
  expect(target.text).toBe("Custom");
  expect(target.instanceOverrides).toContain("text");
  expect(applyDocumentPatch(changed, invertPatch(diffDocument(doc, changed)))).toEqual(doc);
  const duplicate = duplicateNodeTree(changed, "component", id);
  expect(duplicate.nodes[0].componentProperties.label.targetId).toBe(duplicate.nodes[1].id);
  const pasted = pasteLayers(
    blankDesignDocument(),
    readDesignClipboard(copyLayers(doc, ["component"], uid)),
    { fileId: "other", pageId: "page-1", parentId: null, createId: id },
  );
  expect(pasted.document.nodes[0].componentProperties.label.targetId).toBe(
    pasted.document.nodes[1].id,
  );
  expect(
    removeLayers(doc, ["label"]).nodes.find((n) => n.id === "component").componentProperties,
  ).toEqual({});
});
test("linked libraries update stable source identities, structure and properties without losing instance edits", () => {
  let original = exposeComponentProperty(source(), "component", "label", {
    name: "Label",
    targetId: "label",
    property: "text",
  });
  let linked = importLibraryComponent(
    blankDesignDocument(),
    libraryPayload(original, "component", uid),
    1,
    id,
  );
  const cached = linked.document.nodes.find((n) => n.id === linked.rootId);
  expect(cached.librarySource.revision).toBe(1);
  expect(cached.locked).toBe(true);
  let created = createComponentInstance(linked.document, linked.rootId, id);
  let doc = setComponentProperty(created.document, created.rootId, "label", "Custom");
  const target = doc.nodes.find(
    (n) => n.componentSourceId === cached.componentProperties.label.targetId,
  );
  const sourceChanged = editLayers(original, ["label"], {
    text: "Updated",
    style: { fontSize: 24 },
  });
  const extra = {
    ...buildDrawnNode("icon", "container", "component", { x: 130, y: 10, width: 20, height: 20 }),
    style: { fill: "#ff0000" },
  };
  const changed = parseDesignDocument({ ...sourceChanged, nodes: [...sourceChanged.nodes, extra] });
  const refreshed = importLibraryComponent(doc, libraryPayload(changed, "component", uid), 2, id);
  expect(refreshed.rootId).toBe(linked.rootId);
  expect(refreshed.document.nodes.find((n) => n.id === target.id)).toMatchObject({
    text: "Custom",
    style: { fontSize: 24 },
  });
  const acknowledged = applyDocumentPatch(doc, diffDocument(doc, refreshed.document));
  expect(acknowledged.nodes.find((n) => n.id === created.rootId).locked).toBe(false);
  expect(acknowledged.nodes.find((n) => n.id === target.id).text).toBe("Custom");
  const instance = refreshed.document.nodes.find((n) => n.id === created.rootId);
  expect(instance.box).toEqual(doc.nodes.find((n) => n.id === instance.id).box);
  expect(refreshed.document.nodes.filter((n) => n.parentId === created.rootId)).toHaveLength(2);
  expect(
    applyDocumentPatch(refreshed.document, invertPatch(diffDocument(doc, refreshed.document))),
  ).toEqual(doc);
  const unavailable = markLibraryStatus(refreshed.document, linked.rootId, "unavailable");
  expect(unavailable.nodes.find((n) => n.id === target.id).text).toBe("Custom");
  expect(() =>
    importLibraryComponent(refreshed.document, libraryPayload(original, "component", uid), 0, id),
  ).toThrow("older");
});
test("reusable styles propagate updates while preserving explicit local overrides and undo", () => {
  let doc = source();
  doc = createReusableStyle(doc, "label", "typography", "Label text");
  doc = applyReusableStyle(doc, ["component"], "typography");
  doc = editLayers(doc, ["label"], { style: { color: "#ff0000" } });
  const updated = updateReusableStyle(doc, "typography", { fontSize: 24, color: "#00ff00" });
  expect(updated.nodes.find((n) => n.id === "label").style).toMatchObject({
    fontSize: 24,
    color: "#ff0000",
  });
  expect(updated.nodes.find((n) => n.id === "component").style).toMatchObject({
    fontSize: 24,
    color: "#00ff00",
  });
  expect(applyDocumentPatch(updated, invertPatch(diffDocument(doc, updated)))).toEqual(doc);
  const detached = removeReusableStyle(updated, "typography");
  expect(detached.nodes[1].styleId).toBeUndefined();
  expect(detached.nodes[1].style.color).toBe("#ff0000");
  const copied = readDesignClipboard(copyLayers(updated, ["component"], uid));
  expect(copied).not.toBeNull();
  const pasted = pasteLayers(blankDesignDocument(), copied, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: id,
  });
  expect(pasted.document.nodes[0].styleId).toBeUndefined();
  expect(pasted.document.nodes[0].style.fontSize).toBe(24);
});

test("cross-file linked-instance copy brings its cached source and still updates predictably", () => {
  const linked = importLibraryComponent(
    blankDesignDocument(),
    libraryPayload(source(), "component", uid),
    1,
    id,
  );
  const instance = createComponentInstance(linked.document, linked.rootId, id);
  const copied = readDesignClipboard(copyLayers(instance.document, [instance.rootId], "origin"));
  expect(copied).not.toBeNull();
  const pasted = pasteLayers(blankDesignDocument(), copied, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: id,
  });
  expect(pasted.ids).toHaveLength(1);
  const root = pasted.document.nodes.find((n) => n.id === pasted.ids[0]);
  const master = pasted.document.nodes.find((n) => n.id === root.instanceOf);
  expect(master.librarySource.fileUid).toBe(uid);
  const newer = editLayers(source(), ["label"], { text: "New source" });
  const updated = importLibraryComponent(
    pasted.document,
    libraryPayload(newer, "component", uid),
    2,
    id,
  );
  expect(updated.document.nodes.find((n) => n.parentId === root.id).text).toBe("New source");
});

test("replacement keeps instance identity and removed overridden content; unavailable variants fall back", () => {
  const original = parseDesignDocument({
    ...source(),
    nodes: source().nodes.map((n) =>
      n.id === "component"
        ? {
            ...n,
            variants: {
              default: "primary",
              options: { primary: {}, compact: { root: { box: { width: 120 } } } },
            },
          }
        : n,
    ),
  });
  const linked = importLibraryComponent(
    blankDesignDocument(),
    libraryPayload(original, "component", uid),
    1,
    id,
  );
  const instance = createComponentInstance(linked.document, linked.rootId, id);
  const child = instance.document.nodes.find((n) => n.parentId === instance.rootId);
  let edited = editLayers(instance.document, [child.id], { text: "Keep this" });
  edited = editLayers(edited, [instance.rootId], { variant: "compact" });
  const replacedSource = parseDesignDocument({
    ...source(),
    nodes: source().nodes.map((n) => ({
      ...n,
      id: `new-${n.id}`,
      parentId: n.parentId ? `new-${n.parentId}` : null,
    })),
  });
  const replacement = importLibraryComponent(
    edited,
    libraryPayload(replacedSource, "new-component", "00000000-0000-4000-8000-000000000038"),
    1,
    id,
    linked.rootId,
  );
  const acknowledged = applyDocumentPatch(edited, diffDocument(edited, replacement.document));
  expect(acknowledged.nodes.find((n) => n.id === child.id)).toMatchObject({
    text: "Keep this",
    instanceOf: undefined,
    parentId: instance.rootId,
  });
  expect(replacement.document.nodes.find((n) => n.id === instance.rootId).variant).toBeUndefined();
  expect(replacement.document.nodes.find((n) => n.id === child.id)).toMatchObject({
    text: "Keep this",
    instanceOf: undefined,
    parentId: instance.rootId,
  });
  expect(
    replacement.document.nodes.find((n) => n.id === linked.rootId).librarySource.componentId,
  ).toBe("new-component");
  expect(
    applyDocumentPatch(
      replacement.document,
      invertPatch(diffDocument(edited, replacement.document)),
    ),
  ).toEqual(edited);
});

test("persisted linked overrides agree in thumbnails, reviews and exported runtime", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { buildComponentLibraryDocument } = await import("./examples/component-libraries");
  const { DocumentPreview } = await import("@/app/files/thumbnail-renderer");
  const { DesignSnapshot } = await import("@/components/github/design-snapshot");
  const { snapshotFrames } = await import("@/lib/github/validation");
  const { TidyDesign } = await import("./code-runtime");
  let doc = setComponentProperty(
    buildComponentLibraryDocument(),
    "linked-instance",
    "label",
    "Persisted override",
  );
  doc = setComponentProperty(doc, "linked-instance", "size", 26);
  doc = parseDesignDocument(JSON.parse(JSON.stringify(doc)));
  const review = parseDesignDocument(snapshotFrames(doc, ["frame"]));
  const surfaces = [
    renderToStaticMarkup(createElement(DocumentPreview, { content: doc })),
    renderToStaticMarkup(
      createElement(DesignSnapshot, {
        reviewId: "review",
        content: review,
        frameId: "frame",
        selectedNode: null,
        onSelect: () => {},
      }),
    ),
    renderToStaticMarkup(createElement(TidyDesign, { document: doc, rootId: "frame", assets: {} })),
  ];
  for (const html of surfaces) {
    expect(html).toContain("Persisted override");
    expect(html).toContain("font-size:26px");
  }
});

test("a late source-status response cannot mark a replacement library unavailable", () => {
  const linked = importLibraryComponent(
    blankDesignDocument(),
    libraryPayload(source(), "component", uid),
    1,
    id,
  );
  const identity = linked.document.nodes.find((n) => n.id === linked.rootId).librarySource;
  const replaced = importLibraryComponent(
    linked.document,
    libraryPayload(source(), "component", "00000000-0000-4000-8000-000000000038"),
    1,
    id,
    linked.rootId,
  );
  const late = markLibraryStatus(
    replaced.document,
    linked.rootId,
    "unavailable",
    undefined,
    identity,
  );
  expect(late).toEqual(replaced.document);
});

test("library imports preserve destination token definitions and remap source bindings", () => {
  const incoming = parseDesignDocument({
    ...source(),
    designTokens: { corner: { type: "radius", value: 24 } },
    nodes: source().nodes.map((node) =>
      node.id === "component" ? { ...node, tokenBindings: { radius: "corner" } } : node,
    ),
  });
  const destination = parseDesignDocument({
    ...blankDesignDocument(),
    designTokens: { corner: { type: "radius", value: 8 } },
  });
  const linked = importLibraryComponent(
    destination,
    libraryPayload(incoming, "component", uid),
    1,
    id,
  );
  expect(linked.document.designTokens.corner.value).toBe(8);
  expect(
    resolvedDocumentNodes(linked.document).find((node) => node.id === linked.rootId).style.radius,
  ).toBe(24);
});
test("creating a reusable style captures the current token-resolved appearance", () => {
  const initial = parseDesignDocument({
    ...source(),
    designTokens: { size: { type: "dimension", value: 26 } },
    nodes: source().nodes.map((node) =>
      node.id === "label" ? { ...node, tokenBindings: { fontSize: "size" } } : node,
    ),
  });
  const styled = createReusableStyle(initial, "label", "resolved", "Resolved text");
  expect(styled.reusableStyles.resolved.style.fontSize).toBe(26);
  expect(resolvedDocumentNodes(styled).find((node) => node.id === "label").style.fontSize).toBe(26);
});

test("portable component exports materialize styles and omit linked library identities", () => {
  const linked = importLibraryComponent(
    blankDesignDocument(),
    libraryPayload(source(), "component", uid),
    1,
    id,
  );
  const styled = parseDesignDocument({
    ...linked.document,
    reusableStyles: { button: { name: "Button style", style: { fill: "#123456" } } },
    nodes: linked.document.nodes.map((n) =>
      n.id === linked.rootId ? { ...n, styleId: "button" } : n,
    ),
  });
  const exported = componentExportDocument(styled, linked.rootId);
  expect(() => parseDesignDocument(exported)).not.toThrow();
  expect(exported.nodes[0].style.fill).toBe("#123456");
  expect(exported.nodes[0].styleId).toBeUndefined();
  expect(exported.nodes[0].librarySource).toBeUndefined();
  expect(exported.nodes[0].libraryNodeId).toBeUndefined();
});
