import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TidyDesign } from "@tidy/design-renderer/design";
import {
  playInteraction,
  startPrototype,
  prototypeFrameNodes,
  prototypeInteraction,
  prototypeInteractions,
  type PrototypeInteraction,
} from "@bella/design/prototype";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { copyLayers, pasteLayers, readDesignClipboard } from "./clipboard";
import { duplicateNodeTree } from "./duplicate-node";
import { createComponentInstance, removeLayers } from "./document-operations";
import { editLayers } from "./edit-document";
import { syncComponentEdit } from "./component-sync";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";

const interaction = (
  action: PrototypeInteraction["action"],
  trigger: PrototypeInteraction["trigger"] = { type: "click" },
): PrototypeInteraction => ({
  id: crypto.randomUUID(),
  action,
  trigger,
  transition: { type: "fade", duration: 300 },
});
function fixture() {
  const document = blankDesignDocument();
  return parseDesignDocument({
    ...document,
    pages: [...document.pages, { id: "page-two", name: "Second page" }],
    nodes: [
      buildDrawnNode("first", "artboard", null, { x: 0, y: 0, width: 400, height: 300 }),
      {
        ...buildDrawnNode("second", "artboard", null, { x: 700, y: 0, width: 300, height: 200 }),
        pageId: "page-two",
      },
      {
        ...buildDrawnNode("control", "container", "first", {
          x: 20,
          y: 20,
          width: 100,
          height: 40,
        }),
        name: "Next",
        interactions: [interaction({ type: "navigate", target: "second" })],
        states: { hover: { fill: "#112233" }, disabled: { opacity: 0.3 } },
      },
    ],
  });
}
test("prototype schema preserves bounded triggers/transitions and rejects invalid destinations", () => {
  const document = fixture();
  expect(parseDesignDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  for (const action of [
    { type: "navigate", target: "control" },
    { type: "setState", target: "missing", state: "hover" },
    { type: "setVariant", target: "control", variant: "missing" },
  ] as PrototypeInteraction["action"][]) {
    expect(() =>
      parseDesignDocument({
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === "control" ? { ...node, interactions: [interaction(action)] } : node,
        ),
      }),
    ).toThrow();
  }
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: document.nodes.map((node) => ({
        ...node,
        interactions: [
          { ...interaction({ type: "back" }), trigger: { type: "afterDelay", delay: 0 } },
        ],
      })),
    }),
  ).toThrow();
});
test("navigation, nested overlays, back, state and variant playback stay local and reversible", () => {
  const original = startPrototype("first");
  let state = playInteraction(original, interaction({ type: "navigate", target: "second" }));
  expect(state.history).toEqual(["first"]);
  state = playInteraction(
    state,
    interaction({
      type: "openOverlay",
      target: "first",
      position: "bottom",
      dismissOutside: false,
    }),
  );
  state = playInteraction(
    state,
    interaction({ type: "setState", target: "control", state: "hover" }),
  );
  state = playInteraction(
    state,
    interaction({ type: "setVariant", target: "control", variant: "primary" }),
  );
  expect(state.states.control).toBe("hover");
  expect(state.variants.control).toBe("primary");
  state = playInteraction(state, interaction({ type: "back" }));
  expect(state.frameId).toBe("second");
  expect(state.overlays).toHaveLength(0);
  state = playInteraction(state, interaction({ type: "back" }));
  expect(state.frameId).toBe("first");
  expect(state.transition).toEqual({ type: "fade", duration: 300 });
  expect(original).toEqual(startPrototype("first"));
});
test("legacy links and authored keys resolve only their intended trigger", () => {
  const node = {
    ...fixture().nodes[2],
    interactions: [interaction({ type: "back" }, { type: "key", key: "Enter" })],
    linkTo: "second",
  };
  expect(prototypeInteraction(node, "click")?.action).toEqual({
    type: "navigate",
    target: "second",
  });
  expect(prototypeInteraction(node, "key", "Enter")?.action.type).toBe("back");
  expect(prototypeInteraction(node, "key", "Escape")).toBeUndefined();
});
test("copy/duplicate remap internal interaction targets; cross-file copy drops inaccessible destinations", () => {
  const document = fixture();
  let id = 0;
  const duplicated = duplicateNodeTree(document, "first", () => `duplicate-${id++}`);
  expect(duplicated.nodes[1].interactions?.[0].action).toEqual({
    type: "navigate",
    target: "second",
  });
  const payload = readDesignClipboard(copyLayers(document, ["first", "second"], "source"))!;
  const pasted = pasteLayers(blankDesignDocument(), payload, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: () => `paste-${id++}`,
  });
  const source = pasted.document.nodes.find((node) => node.name === "Next")!;
  expect(source.interactions?.[0].action).toEqual({ type: "navigate", target: pasted.ids[1] });
  const partial = readDesignClipboard(copyLayers(document, ["first"], "source"))!;
  const isolated = pasteLayers(blankDesignDocument(), partial, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: () => `isolated-${id++}`,
  });
  expect(isolated.document.nodes.find((node) => node.name === "Next")?.interactions).toEqual([]);
});
test("deleting an interaction target and undo restores references without losing unrelated edits", () => {
  const document = fixture(),
    removed = removeLayers(document, ["second"]);
  expect(removed.nodes.find((node) => node.id === "control")?.interactions).toEqual([]);
  const patch = diffDocument(document, removed);
  const independent = {
    ...removed,
    nodes: removed.nodes.map((node) =>
      node.id === "first" ? { ...node, name: "Remote name" } : node,
    ),
  };
  const restored = parseDesignDocument(applyDocumentPatch(independent, invertPatch(patch), true));
  expect(restored.nodes.find((node) => node.id === "control")?.interactions).toEqual(
    document.nodes[2].interactions,
  );
  expect(restored.nodes[0].name).toBe("Remote name");
});
test("shared renderer gives prototype controls keyboard semantics and paints explicit states", () => {
  const document = fixture();
  const html = renderToStaticMarkup(
    <TidyDesign
      document={document}
      rootId="first"
      assets={{}}
      states={{ control: "hover" }}
      onTrigger={() => false}
    />,
  );
  expect(html).toContain('data-prototype-node="control"');
  expect(html).toContain('role="button" tabindex="0"');
  expect(html).toContain("background:#112233");
  const disabled = renderToStaticMarkup(
    <TidyDesign
      document={document}
      rootId="first"
      assets={{}}
      states={{ control: "disabled" }}
      onTrigger={() => false}
    />,
  );
  expect(disabled).toContain('aria-disabled="true"');
  expect(disabled).toContain("opacity:0.3");
});
test("timed interactions only consider visible descendants of the active cross-page frame", () => {
  const document = fixture();
  expect(prototypeFrameNodes(document, "second").map((node) => node.id)).toEqual(["second"]);
  expect(
    prototypeFrameNodes(
      {
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === "control" ? { ...node, visible: false } : node,
        ),
      },
      "first",
    ).map((node) => node.id),
  ).toEqual(["first"]);
});
test("matching actions run in order and preserve their authored state and navigation", () => {
  const node = {
    ...fixture().nodes[2],
    interactions: [
      interaction({ type: "setState", target: "control", state: "focus" }),
      interaction({ type: "navigate", target: "second" }),
    ],
  };
  const actions = prototypeInteractions(node, "click");
  expect(actions).toHaveLength(2);
  const session = actions.reduce(playInteraction, startPrototype("first"));
  expect(session.states.control).toBe("focus");
  expect(session.frameId).toBe("second");
});
test("component copy and master edits remap self targets; deleting a variant source removes unavailable actions", () => {
  const original = fixture();
  const document = parseDesignDocument({
    ...original,
    nodes: original.nodes.map((node) =>
      node.id === "control"
        ? {
            ...node,
            isComponent: true,
            variants: {
              default: "primary",
              options: { primary: {}, alternate: { root: { style: { fill: "#778899" } } } },
            },
            interactions: [interaction({ type: "setState", target: "control", state: "hover" })],
          }
        : node,
    ),
  });
  const instance = createComponentInstance(document, "control", () => "instance");
  expect(
    instance.document.nodes.find((node) => node.id === "instance")?.interactions?.[0].action,
  ).toEqual({ type: "setState", target: "instance", state: "hover" });
  const synced = parseDesignDocument({
    ...instance.document,
    nodes: syncComponentEdit(instance.document.nodes, "control", {
      interactions: [interaction({ type: "setVariant", target: "control", variant: "alternate" })],
    }),
  });
  expect(synced.nodes.find((node) => node.id === "instance")?.interactions?.[0].action).toEqual({
    type: "setVariant",
    target: "instance",
    variant: "alternate",
  });
  const detached = removeLayers(synced, ["control"]);
  expect(detached.nodes.find((node) => node.id === "instance")?.interactions).toEqual([]);
  const copied = readDesignClipboard(copyLayers(document, ["first"], "source"))!;
  let id = 0;
  const pasted = pasteLayers(blankDesignDocument(), copied, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: () => `variant-copy-${id++}`,
  });
  expect(
    pasted.document.nodes.find((node) => node.isComponent)?.interactions?.[0].action.type,
  ).toBe("setState");
});

test("component reconciliation transports action targets without recording inherited actions as overrides", () => {
  let document = fixture();
  const child = buildDrawnNode("component-child", "text", "control", {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
  });
  document = parseDesignDocument({
    ...document,
    nodes: [
      ...document.nodes.map((n) =>
        n.id === "control"
          ? {
              ...n,
              isComponent: true,
              interactions: [interaction({ type: "setState", target: "control", state: "hover" })],
            }
          : n,
      ),
      { ...child, text: "Child" },
    ],
  });
  let serial = 0;
  const created = createComponentInstance(document, "control", () => `copy-${++serial}`);
  const changed = editLayers(created.document, ["control"], {
    interactions: [interaction({ type: "setState", target: child.id, state: "pressed" })],
  });
  const transported = applyDocumentPatch(created.document, diffDocument(created.document, changed));
  const root = transported.nodes.find((n) => n.id === created.rootId)!;
  const copy = transported.nodes.find((n) => n.componentSourceId === child.id)!;
  expect(root.interactions?.[0].action).toEqual({
    type: "setState",
    target: copy.id,
    state: "pressed",
  });
  expect(root.instanceOverrides).not.toContain("interactions");
  expect(
    applyDocumentPatch(transported, invertPatch(diffDocument(created.document, changed))),
  ).toEqual(created.document);
});
