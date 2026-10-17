import type { DesignNode } from "@tidy/design/document";

export function innerSize(node: DesignNode) {
  const border = node.style.borderWidth ?? 0;
  return {
    width: Math.max(
      1,
      node.box.width -
        (node.style.borderLeftWidth ?? border) -
        (node.style.borderRightWidth ?? border),
    ),
    height: Math.max(
      1,
      node.box.height -
        (node.style.borderTopWidth ?? border) -
        (node.style.borderBottomWidth ?? border),
    ),
  };
}

export function constrainAxis(
  position: number,
  size: number,
  before: number,
  after: number,
  constraint: DesignNode["horizontalConstraint"] = "start",
) {
  const delta = after - before;
  if (constraint === "end") position += delta;
  if (constraint === "center") position += delta / 2;
  if (constraint === "stretch") size += delta;
  if (constraint === "scale") {
    position *= after / before;
    size *= after / before;
  }
  return {
    position: Math.max(-100000, Math.min(100000, position)),
    size: Math.max(1, Math.min(5000, size)),
  };
}

/** Convert measured canvas geometry back to its stored parent-size reference. */
export function storedConstraintBox(
  actual: DesignNode["box"],
  node: DesignNode,
  parent: DesignNode | undefined,
  renderedParent: { width: number; height: number },
): DesignNode["box"] {
  if (!parent || (parent.layout !== "absolute" && node.positionMode !== "absolute")) return actual;
  const reference = innerSize(parent);
  const result = { ...actual };
  for (const axis of ["horizontal", "vertical"] as const) {
    const position = axis === "horizontal" ? "x" : "y";
    const size = axis === "horizontal" ? "width" : "height";
    const constraint = axis === "horizontal" ? node.horizontalConstraint : node.verticalConstraint;
    const mode = axis === "horizontal" ? node.widthMode : node.heightMode;
    if (mode && mode !== "fixed") continue;
    const delta = renderedParent[size] - reference[size];
    if (constraint === "center") result[position] -= delta / 2;
    if (constraint === "end") result[position] -= delta;
    if (constraint === "stretch") result[size] -= delta;
    if (constraint === "scale") {
      result[position] *= reference[size] / renderedParent[size];
      result[size] *= reference[size] / renderedParent[size];
    }
    result[position] = Math.max(-100000, Math.min(100000, result[position]));
    result[size] = Math.max(1, Math.min(5000, result[size]));
  }
  return result;
}

/** Runtime CSS constraints also follow a parent's rendered fill size. */
export function constraintStyle(
  node: DesignNode,
  parent: DesignNode | undefined,
  absolute: boolean,
) {
  if (!absolute || !parent) return {};
  const reference = innerSize(parent);
  const result: {
    left?: string | number;
    top?: string | number;
    width?: string | number;
    height?: string | number;
  } = {};
  for (const axis of ["horizontal", "vertical"] as const) {
    const position = axis === "horizontal" ? "left" : "top";
    const size = axis === "horizontal" ? "width" : "height";
    const coordinate = axis === "horizontal" ? node.box.x : node.box.y;
    const constraint = axis === "horizontal" ? node.horizontalConstraint : node.verticalConstraint;
    const mode = axis === "horizontal" ? node.widthMode : node.heightMode;
    if (!constraint || constraint === "start" || (mode && mode !== "fixed")) continue;
    if (constraint === "center")
      result[position] = `calc(50% + ${coordinate - reference[size] / 2}px)`;
    if (constraint === "end") result[position] = `calc(100% - ${reference[size] - coordinate}px)`;
    if (constraint === "stretch")
      result[size] = `max(1px, calc(100% - ${reference[size] - node.box[size]}px))`;
    if (constraint === "scale") {
      result[position] = `${(coordinate / reference[size]) * 100}%`;
      result[size] = `${(node.box[size] / reference[size]) * 100}%`;
    }
  }
  return result;
}
