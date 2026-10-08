import type { DesignNode } from "./document";

export type NativeShape = NonNullable<NonNullable<DesignNode["vectorPath"]>["shape"]>;
export const shapeKinds = ["ellipse", "line", "arrow", "polygon", "star"] as const;
export function isShapeKind(value: string): value is NativeShape["kind"] {
  return (shapeKinds as readonly string[]).includes(value);
}

/** Keep editable parameters independent from size, rotation, and paint. */
export function nativeShapePath(
  shape: NativeShape,
  viewBox = { x: 0, y: 0, width: 100, height: 100 },
): NonNullable<DesignNode["vectorPath"]> {
  const { x, y, width: w, height: h } = viewBox;
  const cx = x + w / 2,
    cy = y + h / 2;
  let d: string;
  if (shape.kind === "ellipse") {
    d = `M${x} ${cy}a${w / 2} ${h / 2} 0 1 0 ${w} 0a${w / 2} ${h / 2} 0 1 0 ${-w} 0Z`;
  } else if (shape.kind === "line" || shape.kind === "arrow") {
    d = `M${w === 1 ? cx : shape.reverseX ? x + w : x} ${h === 1 ? cy : shape.reverseY ? y + h : y}L${w === 1 ? cx : shape.reverseX ? x : x + w} ${h === 1 ? cy : shape.reverseY ? y : y + h}`;
  } else {
    const points = shape.points ?? (shape.kind === "star" ? 5 : 3);
    const count = shape.kind === "star" ? points * 2 : points;
    d =
      Array.from({ length: count }, (_, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
        const radius = shape.kind === "star" && index % 2 ? (shape.innerRadius ?? 0.5) : 1;
        return `${index ? "L" : "M"}${cx + ((Math.cos(angle) * w) / 2) * radius} ${cy + ((Math.sin(angle) * h) / 2) * radius}`;
      }).join("") + "Z";
  }
  return { d, viewBox, fillRule: "nonzero", shape };
}

export function buildNativeShape(
  id: string,
  shape: NativeShape,
  parentId: string | null,
  box: DesignNode["box"],
): DesignNode {
  const line = shape.kind === "line" || shape.kind === "arrow";
  return {
    id,
    parentId,
    box,
    visible: true,
    locked: false,
    layout: "absolute",
    name: shape.kind[0].toUpperCase() + shape.kind.slice(1),
    type: "vector",
    vectorPath: nativeShapePath(shape, { x: 0, y: 0, width: box.width, height: box.height }),
    style: line
      ? {
          paints: [],
          borderWidth: 2,
          borderColor: "#1e1e1e",
          strokeCap: "round",
          ...(shape.kind === "arrow" ? { strokeEnd: "arrow" as const } : {}),
        }
      : { fill: "#dedede" },
  };
}
