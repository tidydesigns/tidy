import {
  buildDrawnNode,
  designNodeSchema,
  nodePageId,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { isLayerLocked, selectionRoots } from "./edit-document";
import { applyResizeConstraints, innerSize, storedConstraintBox } from "./constraints";
import { syncComponentEdit } from "./component-sync";
import { rotatePoint } from "./resize-box";
import { boundingBox } from "./snapping";

export type MeasuredBoxes = ReadonlyMap<string, DesignNode["box"]>;
export type WrapKind = "group" | "frame" | "auto";
const measuredBox = (node: DesignNode, boxes?: MeasuredBoxes) => boxes?.get(node.id) ?? node.box;
function storedBox(
  document: DesignDocument,
  node: DesignNode,
  actual: DesignNode["box"],
  boxes?: MeasuredBoxes,
) {
  const parent = document.nodes.find((item) => item.id === node.parentId);
  return storedConstraintBox(
    actual,
    { ...node, widthMode: "fixed", heightMode: "fixed" },
    parent,
    parent ? innerSize({ ...parent, box: measuredBox(parent, boxes) }) : { width: 1, height: 1 },
  );
}

function visualBox(node: DesignNode, box: DesignNode["box"]): DesignNode["box"] {
  const corners = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([x, y]) => {
    const point = rotatePoint({ x: x * box.width, y: y * box.height }, node.style.rotation ?? 0);
    return {
      x: box.x + box.width / 2 + point.x,
      y: box.y + box.height / 2 + point.y,
      width: 0,
      height: 0,
    };
  });
  return boundingBox(corners)!;
}

function inferFlow(nodes: DesignNode[], boxes?: MeasuredBoxes) {
  const geometry = nodes.map((node) => ({ node, box: measuredBox(node, boxes) }));
  const centersX = geometry.map(({ box }) => box.x + box.width / 2),
    centersY = geometry.map(({ box }) => box.y + box.height / 2);
  const row =
    Math.max(...centersX) - Math.min(...centersX) > Math.max(...centersY) - Math.min(...centersY);
  const coordinate = row ? "x" : "y",
    size = row ? "width" : "height",
    cross = row ? "y" : "x",
    crossSize = row ? "height" : "width";
  geometry.sort((a, b) => a.box[coordinate] - b.box[coordinate]);
  const gaps = geometry
    .slice(1)
    .map(
      ({ box }, index) =>
        box[coordinate] - geometry[index].box[coordinate] - geometry[index].box[size],
    );
  const spread = (anchor: number) => {
    const values = geometry.map(({ box }) => box[cross] + box[crossSize] * anchor);
    return Math.max(...values) - Math.min(...values);
  };
  const align: DesignNode["align"] =
    spread(0) < 0.1 ? "start" : spread(0.5) < 0.1 ? "center" : spread(1) < 0.1 ? "end" : "start";
  const gap = gaps.length
    ? Math.max(-1000, Math.min(1000, gaps.reduce((a, b) => a + b, 0) / gaps.length))
    : 0;
  const bounds = boundingBox(geometry.map(({ box }) => box))!;
  const anchor = align === "center" ? 0.5 : align === "end" ? 1 : 0;
  const offsets = new Map(
    geometry.map(({ node, box }, index) => {
      const main = index ? gaps[index - 1] - gap : 0;
      const crossOffset =
        box[cross] + box[crossSize] * anchor - bounds[cross] - bounds[crossSize] * anchor;
      if (Math.abs(main) > 5000 || Math.abs(crossOffset) > 5000)
        throw new Error("The selected spacing exceeds the supported layout range.");
      return [
        node.id,
        {
          flowGapBefore: Math.abs(main) >= 0.1 ? main : undefined,
          flowCrossOffset: Math.abs(crossOffset) >= 0.1 ? crossOffset : undefined,
        },
      ] as const;
    }),
  );
  return {
    layout: row ? ("flex-row" as const) : ("flex-column" as const),
    gap,
    align,
    ordered: geometry.map(({ node }) => node),
    bounds,
    offsets,
  };
}

/** Wrapping free geometry freezes rendered root sizes and retains stacking order. */
export function wrapLayers(
  document: DesignDocument,
  ids: string[],
  id: string,
  kind: WrapKind,
  boxes?: MeasuredBoxes,
): { document: DesignDocument; id: string } {
  if (ids.some((nodeId) => isLayerLocked(document.nodes, nodeId)))
    throw new Error("Unlock selected layers before wrapping them.");
  const selected = selectionRoots(document.nodes, ids);
  if (!selected.length) throw new Error("Select layers to wrap.");
  const pageId = nodePageId(selected[0]),
    parentId = selected[0].parentId;
  if (selected.some((node) => node.parentId !== parentId || nodePageId(node) !== pageId))
    throw new Error("Select layers with the same parent.");

  // A selected frame/container already supplies the wrapper for auto layout.
  if (
    kind === "auto" &&
    selected.length === 1 &&
    ["artboard", "container"].includes(selected[0].type)
  ) {
    const root = selected[0];
    const children = document.nodes.filter(
      (node) => node.parentId === root.id && node.visible && node.positionMode !== "absolute",
    );
    if (!children.length)
      return {
        id: root.id,
        document: parseDesignDocument({
          ...document,
          nodes: syncComponentEdit(document.nodes, root.id, { layout: "flex-column" }),
        }),
      };
    const flow = inferFlow(children, boxes);
    const rootBox = measuredBox(root, boxes);
    const size = innerSize({ ...root, box: rootBox });
    const byId = new Map(children.map((node) => [node.id, node]));
    const ordered = flow.ordered.map((node) => ({
      ...node,
      ...flow.offsets.get(node.id),
      box: measuredBox(node, boxes),
      widthMode: "fixed" as const,
      heightMode: "fixed" as const,
      positionMode: "auto" as const,
      horizontalConstraint: "start" as const,
      verticalConstraint: "start" as const,
    }));
    let childIndex = 0;
    const changedRoot = syncComponentEdit(document.nodes, root.id, {
      box: storedBox(document, root, rootBox, boxes),
      layout: flow.layout,
      gap: flow.gap,
      align: flow.align,
      columnGap: undefined,
      rowGap: undefined,
      justify: "start",
      wrap: false,
      padding: undefined,
      paddingLeft: Math.max(0, Math.min(1000, flow.bounds.x)),
      paddingTop: Math.max(0, Math.min(1000, flow.bounds.y)),
      paddingRight: Math.max(0, Math.min(1000, size.width - flow.bounds.x - flow.bounds.width)),
      paddingBottom: Math.max(0, Math.min(1000, size.height - flow.bounds.y - flow.bounds.height)),
    });
    const nodes = changedRoot.map((node): DesignNode =>
      byId.has(node.id) ? ordered[childIndex++] : node,
    );
    return {
      id: root.id,
      document: parseDesignDocument({
        ...document,
        nodes: applyResizeConstraints(document.nodes, nodes),
      }),
    };
  }
  if (selected.some((node) => node.type === "artboard"))
    throw new Error("Choose content layers rather than canvas frames to wrap.");
  const parent = document.nodes.find((node) => node.id === parentId);
  if (parent && parent.layout !== "absolute") {
    const siblings = document.nodes.filter(
      (node) => node.parentId === parentId && node.visible && node.positionMode !== "absolute",
    );
    const positions = selected
      .map((node) => siblings.findIndex((item) => item.id === node.id))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1))
      throw new Error("Choose consecutive layers in this layout.");
  }
  const bounds = boundingBox(selected.map((node) => visualBox(node, measuredBox(node, boxes))))!;
  if (bounds.width > 5000 || bounds.height > 5000)
    throw new Error("The wrapped frame must fit within 5000 × 5000 pixels.");
  const flow = kind === "auto" ? inferFlow(selected, boxes) : null;
  const irregular =
    flow &&
    [...flow.offsets.values()].some(
      (offset) => offset.flowGapBefore !== undefined || offset.flowCrossOffset !== undefined,
    );
  const wrapper: DesignNode = {
    ...buildDrawnNode(id, "container", parentId, {
      ...bounds,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    }),
    pageId,
    name: kind === "frame" ? "Frame" : kind === "auto" ? "Auto layout" : "Group",
    style: kind === "frame" ? { overflow: "hidden" } : {},
    layout: flow?.layout ?? "absolute",
    gap: flow?.gap,
    align: flow?.align,
    widthMode: flow ? "hug" : "fixed",
    heightMode: flow ? "hug" : "fixed",
    minWidth: irregular ? bounds.width : undefined,
    minHeight: irregular ? bounds.height : undefined,
  };
  const chosen = new Set(selected.map((node) => node.id));
  const transformed = new Map(
    selected.map((node) => {
      const box = measuredBox(node, boxes);
      return [
        node.id,
        {
          ...node,
          flowGapBefore: flow?.offsets.get(node.id)?.flowGapBefore,
          flowCrossOffset: flow?.offsets.get(node.id)?.flowCrossOffset,
          parentId: id,
          box: { ...box, x: box.x - bounds.x, y: box.y - bounds.y },
          widthMode: "fixed" as const,
          heightMode: "fixed" as const,
          positionMode: "auto" as const,
          horizontalConstraint: "start" as const,
          verticalConstraint: "start" as const,
        },
      ];
    }),
  );
  const ordered = flow
    ? flow.ordered.map((node) => transformed.get(node.id)!)
    : selected.map((node) => transformed.get(node.id)!);
  let index = 0;
  const nodes = document.nodes.map((node) => (chosen.has(node.id) ? ordered[index++] : node));
  nodes.splice(
    document.nodes.findIndex((node) => chosen.has(node.id)),
    0,
    wrapper,
  );
  return {
    id,
    document: parseDesignDocument({
      ...document,
      nodes: applyResizeConstraints(document.nodes, nodes),
    }),
  };
}

/** Fit free-positioned contents without changing their world-space appearance. */
export function fitContents(
  document: DesignDocument,
  id: string,
  boxes?: MeasuredBoxes,
): DesignDocument {
  const root = document.nodes.find((node) => node.id === id);
  if (!root || !["artboard", "container"].includes(root.type) || isLayerLocked(document.nodes, id))
    throw new Error("Choose an unlocked frame or container to fit.");
  const children = document.nodes.filter(
    (node) =>
      node.parentId === id &&
      node.visible &&
      (root.layout === "absolute" || node.positionMode !== "absolute"),
  );
  if (!children.length) throw new Error("This frame has no visible contents to fit.");
  const bounds = boundingBox(children.map((node) => visualBox(node, measuredBox(node, boxes))))!;
  const left = root.paddingLeft ?? root.padding ?? 0,
    right = root.paddingRight ?? root.padding ?? 0;
  const top = root.paddingTop ?? root.padding ?? 0,
    bottom = root.paddingBottom ?? root.padding ?? 0;
  const border = root.style.borderWidth ?? 0;
  const width = Math.max(
    1,
    bounds.width +
      left +
      right +
      (root.style.borderLeftWidth ?? border) +
      (root.style.borderRightWidth ?? border),
  );
  const height = Math.max(
    1,
    bounds.height +
      top +
      bottom +
      (root.style.borderTopWidth ?? border) +
      (root.style.borderBottomWidth ?? border),
  );
  if (width > 5000 || height > 5000)
    throw new Error("The fitted frame must fit within 5000 × 5000 pixels.");
  const beforeBox = measuredBox(root, boxes);
  const offset = rotatePoint(
    {
      x: (bounds.x - left + (width - beforeBox.width) / 2) * (root.style.flipX ? -1 : 1),
      y: (bounds.y - top + (height - beforeBox.height) / 2) * (root.style.flipY ? -1 : 1),
    },
    root.style.rotation ?? 0,
  );
  const actual = {
    x: beforeBox.x + beforeBox.width / 2 + offset.x - width / 2,
    y: beforeBox.y + beforeBox.height / 2 + offset.y - height / 2,
    width,
    height,
  };
  const free = root.layout === "absolute";
  const box = storedBox(document, root, free ? actual : { ...beforeBox, width, height }, boxes);
  let nodes = syncComponentEdit(document.nodes, id, {
    box,
    widthMode: free ? "fixed" : "hug",
    heightMode: free ? "fixed" : "hug",
  });
  const chosen = new Set(children.map((node) => node.id));
  nodes = nodes.map((node) => {
    if (!chosen.has(node.id)) return node;
    const measured = measuredBox(
      children.find((item) => item.id === node.id)!,
      boxes,
    );
    return {
      ...node,
      box: {
        ...measured,
        x: free ? measured.x - bounds.x + left : measured.x,
        y: free ? measured.y - bounds.y + top : measured.y,
      },
      widthMode: node.widthMode === "fill" ? "fixed" : node.widthMode,
      heightMode: node.heightMode === "fill" ? "fixed" : node.heightMode,
    };
  });
  return parseDesignDocument({
    ...document,
    nodes: applyResizeConstraints(document.nodes, nodes, chosen),
  });
}

/** Ungroup rendered flow/rotated geometry, rather than stale stored child offsets. */
export function unwrapLayer(
  document: DesignDocument,
  id: string,
  boxes?: MeasuredBoxes,
): DesignDocument {
  const root = document.nodes.find((node) => node.id === id);
  if (!root || root.type !== "container" || isLayerLocked(document.nodes, id))
    throw new Error("Choose an unlocked container to ungroup.");
  if (root.isComponent || root.instanceOf)
    throw new Error("Detach this component before ungrouping it.");
  const parent = document.nodes.find((node) => node.id === root.parentId),
    rootBox = measuredBox(root, boxes);
  const children = document.nodes.filter((node) => node.parentId === id);
  const chosen = new Set(children.map((node) => node.id));
  const border = root.style.borderWidth ?? 0;
  const replacements = children.map((node): DesignNode => {
    const box = measuredBox(node, boxes);
    const point = rotatePoint(
      {
        x:
          (box.x + (root.style.borderLeftWidth ?? border) + box.width / 2 - rootBox.width / 2) *
          (root.style.flipX ? -1 : 1),
        y:
          (box.y + (root.style.borderTopWidth ?? border) + box.height / 2 - rootBox.height / 2) *
          (root.style.flipY ? -1 : 1),
      },
      root.style.rotation ?? 0,
    );
    const rotation =
      (root.style.rotation ?? 0) +
      (Boolean(root.style.flipX) !== Boolean(root.style.flipY) ? -1 : 1) *
        (node.style.rotation ?? 0);
    return {
      ...node,
      parentId: root.parentId,
      box: {
        x: rootBox.x + rootBox.width / 2 + point.x - box.width / 2,
        y: rootBox.y + rootBox.height / 2 + point.y - box.height / 2,
        width: box.width,
        height: box.height,
      },
      style: {
        ...node.style,
        rotation: ((rotation + 540) % 360) - 180,
        flipX: Boolean(root.style.flipX) !== Boolean(node.style.flipX),
        flipY: Boolean(root.style.flipY) !== Boolean(node.style.flipY),
      },
      widthMode: "fixed",
      heightMode: "fixed",
      horizontalConstraint: "start",
      verticalConstraint: "start",
      positionMode: parent?.layout !== "absolute" && parent ? "auto" : "absolute",
      flowGapBefore: undefined,
      flowCrossOffset: undefined,
    };
  });
  const nodes = document.nodes.filter((node) => node.id !== id && !chosen.has(node.id));
  const index = document.nodes
    .slice(
      0,
      document.nodes.findIndex((node) => node.id === id),
    )
    .filter((node) => !chosen.has(node.id)).length;
  nodes.splice(index, 0, ...replacements);
  return parseDesignDocument({ ...document, nodes: applyResizeConstraints(document.nodes, nodes) });
}

const styleLengths = [
  "borderWidth",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "radius",
  "radiusTopLeft",
  "radiusTopRight",
  "radiusBottomRight",
  "radiusBottomLeft",
  "fontSize",
  "lineHeightPx",
  "paragraphSpacing",
  "letterSpacing",
  "blur",
  "backdropBlur",
  "outlineWidth",
] as const;
const nodeLengths = [
  "gap",
  "columnGap",
  "rowGap",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "flowGapBefore",
  "flowCrossOffset",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
] as const;
export function scaleLayers(
  document: DesignDocument,
  ids: string[],
  factor: number,
  boxes?: MeasuredBoxes,
  preview = false,
): DesignDocument {
  if (!Number.isFinite(factor) || factor < 0.01 || factor > 100)
    throw new Error("Choose a scale between 1% and 10000%.");
  if (factor === 1) return document;
  if (ids.some((id) => isLayerLocked(document.nodes, id)))
    throw new Error("Unlock selected layers before scaling them.");
  const roots = selectionRoots(document.nodes, ids);
  if (
    !roots.length ||
    roots.some(
      (node) => node.parentId !== roots[0].parentId || nodePageId(node) !== nodePageId(roots[0]),
    )
  )
    throw new Error("Select sibling layers to scale together.");
  const bounds = boundingBox(roots.map((node) => measuredBox(node, boxes)))!;
  const rootIds = new Set(roots.map((node) => node.id)),
    included = new Set(rootIds);
  for (let expanded = true; expanded;) {
    expanded = false;
    for (const node of document.nodes)
      if (node.parentId && included.has(node.parentId) && !included.has(node.id)) {
        included.add(node.id);
        expanded = true;
      }
  }
  let nodes = document.nodes;
  for (const node of document.nodes.filter((node) => included.has(node.id))) {
    const box = measuredBox(node, boxes),
      root = rootIds.has(node.id);
    const actual = {
      x: root ? bounds.x + (box.x - bounds.x) * factor : box.x * factor,
      y: root ? bounds.y + (box.y - bounds.y) * factor : box.y * factor,
      width: box.width * factor,
      height: box.height * factor,
    };
    const current = nodes.find((item) => item.id === node.id)!;
    const style: DesignNode["style"] = {};
    for (const key of styleLengths)
      if (
        !(node.vectorPath && key.startsWith("border")) &&
        node.style[key] !== undefined &&
        node.style[key]! * factor !== current.style[key]
      )
        style[key] = node.style[key]! * factor;
    if (node.style.effects) {
      const effects = node.style.effects.map((effect) =>
        effect.type === "blur" ? { ...effect, amount: effect.amount * factor } : effect,
      );
      if (JSON.stringify(effects) !== JSON.stringify(current.style.effects))
        style.effects = effects;
    }
    if (node.style.shadows) {
      const shadows = node.style.shadows.map((shadow) => ({
        ...shadow,
        x: shadow.x * factor,
        y: shadow.y * factor,
        blur: shadow.blur * factor,
        spread: shadow.spread * factor,
      }));
      if (JSON.stringify(shadows) !== JSON.stringify(current.style.shadows))
        style.shadows = shadows;
    }
    for (const key of ["shadow", "innerShadow"] as const)
      if (node.style[key]) {
        const value = node.style[key]!.replace(
          /(-?\d*\.?\d+)px\b/g,
          (_, value) => `${Math.round(Number(value) * factor * 1000) / 1000}px`,
        );
        if (value !== current.style[key]) style[key] = value;
      }
    const lengths = Object.fromEntries(
      nodeLengths
        .filter((key) => node[key] !== undefined && node[key]! * factor !== current[key])
        .map((key) => [key, node[key]! * factor]),
    );
    const target = root ? storedBox(document, node, actual, boxes) : actual;
    const boxChanges = Object.fromEntries(
      Object.entries(target).filter(
        ([key, value]) => current.box[key as keyof DesignNode["box"]] !== value,
      ),
    );
    nodes = syncComponentEdit(nodes, node.id, {
      ...lengths,
      box: boxChanges,
      style,
      ...(root ? { widthMode: "fixed", heightMode: "fixed" } : {}),
    });
  }
  try {
    if (!preview) return parseDesignDocument({ ...document, nodes });
    const original = new Map(document.nodes.map((node) => [node.id, node]));
    return {
      ...document,
      nodes: nodes.map((node) =>
        original.get(node.id) === node ? node : designNodeSchema.parse(node),
      ),
    };
  } catch {
    throw new Error("The scaled selection exceeds the supported geometry or style limits.");
  }
}

/** Resize the selected roots as one bounding box without scaling their visual styles. */
export function resizeSelectedLayers(
  document: DesignDocument,
  ids: string[],
  target: DesignNode["box"],
  boxes?: MeasuredBoxes,
  preview = false,
): DesignDocument {
  if (ids.some((id) => isLayerLocked(document.nodes, id)))
    throw new Error("Unlock selected layers before resizing them.");
  const roots = selectionRoots(document.nodes, ids);
  if (
    roots.length < 2 ||
    roots.some(
      (node) => node.parentId !== roots[0].parentId || nodePageId(node) !== nodePageId(roots[0]),
    )
  ) {
    throw new Error("Select sibling layers to resize together.");
  }
  const bounds = boundingBox(roots.map((node) => measuredBox(node, boxes)))!;
  if (
    target.x === bounds.x &&
    target.y === bounds.y &&
    target.width === bounds.width &&
    target.height === bounds.height
  )
    return document;
  const scaleX = target.width / Math.max(1, bounds.width),
    scaleY = target.height / Math.max(1, bounds.height);
  let nodes = document.nodes;
  for (const root of roots) {
    const box = measuredBox(root, boxes);
    const actual = {
      x: target.x + (box.x - bounds.x) * scaleX,
      y: target.y + (box.y - bounds.y) * scaleY,
      width: box.width * scaleX,
      height: box.height * scaleY,
    };
    const stored = storedBox(document, root, actual, boxes);
    nodes = syncComponentEdit(nodes, root.id, {
      box: stored,
      widthMode: "fixed",
      heightMode: "fixed",
    });
  }
  try {
    if (!preview) return parseDesignDocument({ ...document, nodes });
    const original = new Map(document.nodes.map((node) => [node.id, node]));
    return {
      ...document,
      nodes: nodes.map((node) =>
        original.get(node.id) === node ? node : designNodeSchema.parse(node),
      ),
    };
  } catch {
    throw new Error("The resized selection exceeds the supported geometry limits.");
  }
}
