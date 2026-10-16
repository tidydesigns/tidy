import { blankDesignDocument, buildDrawnNode } from "@bella/design/document";
import type { DesignDocument, DesignNode } from "@bella/design/document";
import { parsePathContours, serializeContours } from "@bella/design/vector-geometry";
import { exportClone, selectionBounds } from "../../lib/design/export-dom";

type Fixture = {
  document: DesignDocument;
  roots: DesignNode[];
  elements: Map<string, HTMLElement>;
  host: HTMLElement;
};

function fixture(nodes: DesignNode[], rootIds: string[]): Fixture {
  const host = document.createElement("div");
  host.style.cssText = "position:relative;width:1200px;height:900px;";
  document.body.replaceChildren(host);
  const elements = new Map<string, HTMLElement>();
  for (const node of nodes) {
    const element = document.createElement("div");
    element.dataset.nodeId = node.id;
    const { x, y, width, height } = node.box;
    element.style.cssText = `position:absolute;box-sizing:border-box;left:${x}px;top:${y}px;width:${width}px;height:${height}px;overflow:visible;transform-origin:37% 63%;font:italic 600 18px/24px Arial;color:rgb(21, 34, 55);letter-spacing:0.5px;white-space:pre-wrap;`;
    element.style.transform = `rotate(${node.style.rotation ?? 0}deg) scale(${node.style.flipX ? -1 : 1},${node.style.flipY ? -1 : 1})`;
    element.style.opacity = String(node.style.opacity ?? 1);
    if (node.id === "clipped") element.style.overflow = "hidden";
    if (node.id === "parent") element.style.border = "3px solid transparent";
    if (node.type === "text") {
      const text = document.createElement("span");
      text.dataset.designText = "";
      text.textContent = "Wrapped export text\nwith inherited fonts";
      element.appendChild(text);
      const control = document.createElement("button");
      control.textContent = "Selection control";
      element.appendChild(control);
    }
    (node.parentId ? elements.get(node.parentId)! : host).appendChild(element);
    elements.set(node.id, element);
  }
  const documentValue = { ...blankDesignDocument(), nodes };
  return {
    document: documentValue,
    roots: rootIds.map((id) => nodes.find((node) => node.id === id)!),
    elements,
    host,
  };
}

function geometryFixture() {
  const node = (
    id: string,
    parentId: string | null,
    x: number,
    y: number,
    width = 100,
    height = 70,
  ) => buildDrawnNode(id, id === "text" ? "text" : "container", parentId, { x, y, width, height });
  const parent = node("parent", null, 120, 80, 600, 420);
  parent.style.rotation = 17;
  const root = node("root", "parent", 33, 21, 260, 180);
  root.style.rotation = -23;
  root.style.flipX = true;
  const text = node("text", "root", -28, 35, 130, 54);
  const shadow = node("shadow", "root", 210, 125, 80, 50);
  shadow.style = {
    borderWidth: 8,
    strokePosition: "outside",
    blur: 2,
    shadows: [
      {
        id: "shadow-1",
        x: -9,
        y: 13,
        blur: 12,
        spread: 4,
        color: "#000000",
        inset: false,
        visible: true,
      },
    ],
  };
  const clipped = node("clipped", "root", 30, 105, 80, 60);
  const clippedChild = node("clipped-child", "clipped", 500, 500);
  const transparent = node("transparent", "root", -1000, -1000);
  transparent.style.opacity = 0;
  const hidden = node("hidden", "root", 1000, 1000);
  hidden.visible = false;
  const path = node("path", "root", 110, -35, 80, 60);
  path.type = "vector";
  const contours = parsePathContours("M-10 -15 L95 -15 L95 75 L-10 75Z");
  path.vectorPath = {
    d: serializeContours(contours),
    viewBox: { x: 0, y: 0, width: 80, height: 60 },
    fillRule: "nonzero",
    contours,
  };
  const boolean = node("boolean", "root", 170, 40, 80, 60);
  boolean.vectorBoolean = "union";
  const left = node("boolean-left", "boolean", -12, -8, 45, 40);
  left.type = "vector";
  left.vectorPath = {
    d: "M0 0H45V40H0Z",
    viewBox: { x: 0, y: 0, width: 45, height: 40 },
    fillRule: "nonzero",
  };
  const right = node("boolean-right", "boolean", 20, 10, 75, 70);
  right.type = "vector";
  right.vectorPath = {
    d: "M0 0H75V70H0Z",
    viewBox: { x: 0, y: 0, width: 75, height: 70 },
    fillRule: "nonzero",
  };
  return fixture(
    [
      parent,
      root,
      text,
      shadow,
      clipped,
      clippedChild,
      transparent,
      hidden,
      path,
      boolean,
      left,
      right,
    ],
    ["root"],
  );
}

function snapshot(current: Fixture, roots = current.roots) {
  const nodes = new Map(current.document.nodes.map((node) => [node.id, node]));
  const bounds = selectionBounds(roots, current.elements, current.document, nodes);
  const clones = roots.map((node) =>
    exportClone(current.elements.get(node.id)!, node, nodes, bounds),
  );
  return { bounds, clones: clones.map((clone) => clone.outerHTML) };
}

function regression() {
  const current = geometryFixture();
  const individualBounds = Object.fromEntries(
    ["shadow", "clipped", "path", "boolean"].map((id) => [
      id,
      selectionBounds(
        [current.document.nodes.find((node) => node.id === id)!],
        current.elements,
        current.document,
      ),
    ]),
  );
  const before = snapshot(current);
  const independentRoots = ["text", "path"].map((id) =>
    current.document.nodes.find((node) => node.id === id)!,
  );
  const combined = snapshot(current, independentRoots);
  const nodes = new Map(current.document.nodes.map((node) => [node.id, node]));
  const batchBounds = independentRoots.map((node) =>
    selectionBounds([node], current.elements, current.document, nodes),
  );
  // A later export must reflect a moved/resized node, including its inherited transform.
  const root = current.elements.get("root")!;
  root.style.left = "73px";
  root.style.width = "310px";
  current.elements.get("parent")!.style.transform = "rotate(31deg) scale(1,-1)";
  const after = snapshot(current);
  return { before, after, individualBounds, combined, batchBounds };
}

function benchmark(count: number, samples = 5) {
  const root = buildDrawnNode("root", "container", null, { x: 0, y: 0, width: 1000, height: 800 });
  const nodes = [root];
  for (let index = 1; index < count; index++) {
    const parentId = index < 20 ? "root" : `layer-${Math.floor((index - 20) / 20) + 1}`;
    nodes.push(
      buildDrawnNode(`layer-${index}`, "container", parentId, {
        x: (index % 20) * 3,
        y: Math.floor(index / 20) % 20,
        width: 20,
        height: 15,
      }),
    );
  }
  const current = fixture(nodes, ["root"]);
  // Settle layout before timing JavaScript geometry and clone preparation.
  current.host.getBoundingClientRect();
  const durations: number[] = [];
  let result: ReturnType<typeof snapshot> | undefined;
  let styleReads = 0;
  const originalComputedStyle = window.getComputedStyle;
  window.getComputedStyle = (...args: Parameters<typeof getComputedStyle>) => {
    styleReads++;
    return originalComputedStyle(...args);
  };
  try {
    for (let index = 0; index < samples + 1; index++) {
      const start = performance.now();
      result = snapshot(current);
      const elapsed = performance.now() - start;
      if (index > 0) durations.push(elapsed);
    }
  } finally {
    window.getComputedStyle = originalComputedStyle;
  }
  return {
    count,
    durations,
    styleReadsPerSample: styleReads / (samples + 1),
    bounds: result!.bounds,
    cloneLength: result!.clones[0].length,
  };
}

declare global {
  interface Window {
    exportGeometryFixture: { regression: typeof regression; benchmark: typeof benchmark };
  }
}
window.exportGeometryFixture = { regression, benchmark };
