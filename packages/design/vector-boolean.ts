import type {} from "paper";
import Paper from "paper/dist/paper-core";
import type { DesignNode } from "./document";

export type VectorBoolean = "union" | "subtract" | "intersect" | "exclude";
export type Affine = [number, number, number, number, number, number];
export function multiplyAffine(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function nodeAffine(node: DesignNode): Affine {
  const { x, y, width, height } = node.box,
    angle = ((node.style.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle),
    sx = node.style.flipX ? -1 : 1,
    sy = node.style.flipY ? -1 : 1;
  const a = c * sx,
    b = s * sx,
    d = c * sy,
    e = -s * sy;
  return [
    a,
    b,
    e,
    d,
    x + width / 2 - (a * width) / 2 - (e * height) / 2,
    y + height / 2 - (b * width) / 2 - (d * height) / 2,
  ];
}
export function pathAffine(node: DesignNode): Affine {
  const box = node.vectorPath!.viewBox;
  const sx = node.box.width / box.width,
    sy = node.box.height / box.height;
  return multiplyAffine(nodeAffine(node), [sx, 0, 0, sy, -box.x * sx, -box.y * sy]);
}
export function transformedBox(node: DesignNode) {
  const m = nodeAffine(node);
  const points = [
    [0, 0],
    [node.box.width, 0],
    [0, node.box.height],
    [node.box.width, node.box.height],
  ].map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }));
  const left = Math.min(...points.map((p) => p.x)),
    top = Math.min(...points.map((p) => p.y));
  return {
    x: left,
    y: top,
    width: Math.max(...points.map((p) => p.x)) - left,
    height: Math.max(...points.map((p) => p.y)) - top,
  };
}

let sharedScope: InstanceType<typeof Paper.PaperScope> | undefined;
type Bounds = { x: number; y: number; width: number; height: number };
const paintedBounds = new WeakMap<DesignNode, Bounds>();
const cache = new WeakMap<DesignNode, { dependencies: DesignNode[]; d: string; bounds: Bounds }>();
/** Curves remain curves. Results are derived from preserved operand nodes, never flattened assets. */
export function vectorBooleanPath(node: DesignNode, nodes: readonly DesignNode[]): string {
  const children = new Map<string, DesignNode[]>();
  for (const n of nodes)
    if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  const dependencies: DesignNode[] = [];
  const collect = (n: DesignNode) => {
    dependencies.push(n);
    for (const child of children.get(n.id) ?? []) collect(child);
  };
  collect(node);
  const previous = cache.get(node);
  if (
    previous &&
    previous.dependencies.length === dependencies.length &&
    dependencies.every((n, i) => n === previous.dependencies[i])
  )
    return previous.d;
  const scope = (sharedScope ??= new Paper.PaperScope());
  scope.activate();
  const project = new scope.Project(new scope.Size(1, 1));
  project.view.autoUpdate = false;
  try {
    const geometry = (n: DesignNode, depth = 0): paper.PathItem => {
      if (depth > 40) throw new Error("Vector boolean nesting exceeds 40.");
      if (n.vectorPath && !n.vectorBoolean) {
        const item = new scope.CompoundPath({ pathData: n.vectorPath.d, insert: false });
        item.fillRule = n.vectorPath.fillRule;
        item.transform(new scope.Matrix(...pathAffine(n)));
        return item;
      }
      const operands = (children.get(n.id) ?? []).filter((child) => child.visible);
      let result: paper.PathItem | undefined;
      for (const operand of operands) {
        const next = geometry(operand, depth + 1);
        if (!result) {
          result = next;
          continue;
        }
        const operation = n.vectorBoolean === "union" ? "unite" : n.vectorBoolean!;
        const combined = result[operation](next, { insert: false });
        result.remove();
        next.remove();
        result = combined;
      }
      result ??= new scope.Path({ insert: false });
      if (n !== node) result.transform(new scope.Matrix(...nodeAffine(n)));
      return result;
    };
    const result = geometry(node);
    const d = result.pathData || "M0 0";
    const bounds = {
      x: result.bounds.x,
      y: result.bounds.y,
      width: result.bounds.width,
      height: result.bounds.height,
    };
    cache.set(node, { dependencies, d, bounds });
    return d;
  } finally {
    project.remove();
  }
}

export function booleanRenderNode(node: DesignNode, nodes: readonly DesignNode[]): DesignNode {
  if (!node.vectorBoolean) return node;
  const d = vectorBooleanPath(node, nodes);
  const rendered: DesignNode = {
    ...node,
    type: "vector",
    vectorPath: {
      d,
      viewBox: { x: 0, y: 0, width: node.box.width, height: node.box.height },
      fillRule: "nonzero",
    },
  };
  paintedBounds.set(rendered, cache.get(node)!.bounds);
  return rendered;
}

export function booleanPaintBounds(node: DesignNode) {
  return paintedBounds.get(node);
}

/** Authored points can extend beyond their viewport; legacy SVG assets retain clipping. */
export function authoredPathBounds(node: DesignNode) {
  const painted = paintedBounds.get(node);
  if (painted || !node.vectorPath || !("contours" in node.vectorPath)) return painted;
  const scope = (sharedScope ??= new Paper.PaperScope());
  scope.activate();
  const project = new scope.Project(new scope.Size(1, 1));
  project.view.autoUpdate = false;
  try {
    const path = new scope.CompoundPath({ pathData: node.vectorPath.d, insert: false });
    const vb = node.vectorPath.viewBox,
      sx = node.box.width / vb.width,
      sy = node.box.height / vb.height;
    path.transform(new scope.Matrix(sx, 0, 0, sy, -vb.x * sx, -vb.y * sy));
    const bounds = {
      x: path.bounds.x,
      y: path.bounds.y,
      width: path.bounds.width,
      height: path.bounds.height,
    };
    paintedBounds.set(node, bounds);
    return bounds;
  } finally {
    project.remove();
  }
}
