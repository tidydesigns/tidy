import { designNodeSchema, type DesignNode } from "./document";
import { parsePathContours, serializeContours } from "@bella/design/vector-geometry";

type Imported = Pick<DesignNode, "vectorPath" | "style">;
export type SvgImportResult =
  | { editable: Imported; reason?: never }
  | { editable?: never; reason: string };

/** Unsupported SVG features retain the original asset, without changing their appearance. */
export function inspectSvgImport(source: string): SvgImportResult {
  const fallback = (reason: string): SvgImportResult => ({
    reason: `Original SVG retained: ${reason}`,
  });
  if (typeof DOMParser === "undefined" || /<!DOCTYPE|<!ENTITY/i.test(source))
    return fallback("unsupported XML declarations.");
  const document = new DOMParser().parseFromString(source, "image/svg+xml"),
    root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== "http://www.w3.org/2000/svg" ||
    document.querySelector("parsererror")
  )
    return fallback("invalid SVG.");
  const presentation = [
    "fill",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
  ];
  const allowed = (element: Element, keys: string[]) =>
    [...element.attributes].every((a) => keys.includes(a.name));
  if (!allowed(root, ["xmlns", "viewBox", "width", "height", ...presentation]))
    return fallback("viewport attributes require asset rendering.");
  const values = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!values || values.length !== 4 || values.some((v) => !Number.isFinite(v)))
    return fallback("a numeric viewBox is required for editing.");
  const [x, y, width, height] = values;
  const sourceWidth = Number(root.getAttribute("width") ?? width),
    sourceHeight = Number(root.getAttribute("height") ?? height);
  if (
    !(width > 0 && height > 0 && sourceWidth > 0 && sourceHeight > 0) ||
    Math.abs(sourceWidth / sourceHeight - width / height) > 0.00001
  )
    return fallback("viewport scaling requires asset rendering.");
  const shapes = [...root.children].filter((e) => !["title", "desc"].includes(e.localName));
  if (!shapes.length) return fallback("no editable shapes.");
  const paths: string[] = [];
  let paints: string[] | undefined;
  for (const shape of shapes) {
    const attributes: Record<string, string[]> = {
      path: ["d"],
      rect: ["x", "y", "width", "height", "rx", "ry"],
      circle: ["cx", "cy", "r"],
      ellipse: ["cx", "cy", "rx", "ry"],
      line: ["x1", "y1", "x2", "y2"],
      polyline: ["points"],
      polygon: ["points"],
    };
    if (
      !attributes[shape.localName] ||
      shape.children.length ||
      !allowed(shape, ["id", ...attributes[shape.localName], ...presentation])
    )
      return fallback(
        "groups, transforms, gradients, clipping, text and effects require asset rendering.",
      );
    const defaults: Record<string, string> = {
      fill: "black",
      "fill-rule": "nonzero",
      stroke: "none",
      "stroke-width": "1",
      "stroke-linecap": "butt",
      "stroke-linejoin": "miter",
    };
    const style = presentation.map(
      (key) => shape.getAttribute(key) ?? root.getAttribute(key) ?? defaults[key],
    );
    if (paints && JSON.stringify(paints) !== JSON.stringify(style))
      return fallback("shapes with different paints require asset rendering.");
    paints = style;
    const n = (key: string, defaultValue = 0) => Number(shape.getAttribute(key) ?? defaultValue);
    const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
      `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`;
    if (shape.localName === "path") paths.push(shape.getAttribute("d") ?? "");
    else if (shape.localName === "circle" || shape.localName === "ellipse") {
      const rx = n(shape.localName === "circle" ? "r" : "rx"),
        ry = shape.localName === "circle" ? rx : n("ry");
      if (!(rx > 0 && ry > 0)) return fallback("empty ellipse.");
      paths.push(ellipse(n("cx"), n("cy"), rx, ry));
    } else if (shape.localName === "rect") {
      const x = n("x"),
        y = n("y"),
        w = n("width"),
        h = n("height");
      const rx = Math.min(w / 2, n("rx", n("ry"))),
        ry = Math.min(h / 2, n("ry", n("rx")));
      if (!(w > 0 && h > 0 && rx >= 0 && ry >= 0)) return fallback("invalid rectangle.");
      paths.push(
        rx && ry
          ? `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
          : `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`,
      );
    } else if (shape.localName === "line")
      paths.push(`M ${n("x1")} ${n("y1")} L ${n("x2")} ${n("y2")}`);
    else {
      const points =
        shape
          .getAttribute("points")
          ?.trim()
          .split(/[\s,]+/)
          .map(Number) ?? [];
      if (points.length < 4 || points.length % 2 || points.some((v) => !Number.isFinite(v)))
        return fallback("invalid polygon points.");
      paths.push(
        `M ${points[0]} ${points[1]} ${points
          .slice(2)
          .map((v, i) => (i % 2 ? `${v}` : `L ${v}`))
          .join(" ")}${shape.localName === "polygon" ? " Z" : ""}`,
      );
    }
  }
  const color = (value: string) =>
    value === "none"
      ? undefined
      : value === "black"
        ? "#000000"
        : value === "white"
          ? "#ffffff"
          : /^#[\da-f]{3}$/i.test(value)
            ? `#${[...value.slice(1)].map((c) => c + c).join("")}`
            : /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)
              ? value
              : null;
  const [fillValue, fillRule, strokeValue, strokeWidth, strokeCap, strokeJoin] = paints!;
  const fill = color(fillValue),
    stroke = color(strokeValue);
  if (fill === null || stroke === null) return fallback("paint requires asset rendering.");
  try {
    const contours = parsePathContours(paths.join(" "));
    const result = designNodeSchema.pick({ vectorPath: true, style: true }).safeParse({
      vectorPath: {
        d: serializeContours(contours),
        contours,
        viewBox: { x, y, width, height },
        fillRule,
      },
      style: {
        paints: fill
          ? [{ id: "svg-fill", type: "solid", color: fill, opacity: 1, visible: true }]
          : [],
        strokePaints: stroke
          ? [{ id: "svg-stroke", type: "solid", color: stroke, opacity: 1, visible: true }]
          : [],
        borderWidth: stroke ? Number(strokeWidth) : 0,
        strokeCap,
        strokeJoin,
      },
    });
    return result.success
      ? { editable: result.data }
      : fallback("geometry or paint exceeds editor limits.");
  } catch {
    return fallback("path data cannot be converted to editable points.");
  }
}

export function importSvgPath(source: string): Imported | undefined {
  return inspectSvgImport(source).editable;
}
