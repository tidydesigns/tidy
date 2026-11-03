import { designNodeSchema, type DesignNode } from "./document";
import { parsePathContours, serializeContours } from "@tidy/design/vector-geometry";

type Imported = Pick<DesignNode, "vectorPath" | "style">;
export type SvgImportResult =
  | { editable: Imported; reason?: never }
  | { editable?: never; reason: string };

export type SvgElementData = {
  name: string;
  attributes: Record<string, string>;
  children: SvgElementData[];
};

export function parseSvgElements(source: string): SvgElementData {
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(source))
    throw new Error("Unsupported XML declarations.");
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== "http://www.w3.org/2000/svg" ||
    document.querySelector("parsererror")
  )
    throw new Error("Invalid SVG.");
  let count = 0;
  const walk = (element: Element, depth: number): SvgElementData => {
    if (++count > 10000 || depth > 40) throw new Error("SVG exceeds import limits.");
    return {
      name: element.localName,
      attributes: Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])),
      children: [...element.children].map((child) => walk(child, depth + 1)),
    };
  };
  return walk(root, 0);
}

export function inspectSvgImport(source: string): SvgImportResult {
  try {
    return inspectSvgElements(parseSvgElements(source));
  } catch {
    return { reason: "Original SVG retained: invalid SVG or unsupported XML declarations." };
  }
}

export function inspectSvgElements(root: SvgElementData): SvgImportResult {
  const fallback = (reason: string): SvgImportResult => ({
    reason: `Original SVG retained: ${reason}`,
  });
  const presentation = [
    "fill",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
  ];
  const allowed = (element: SvgElementData, keys: string[]) =>
    Object.keys(element.attributes).every((name) => keys.includes(name));
  if (
    !allowed(root, ["xmlns", "viewBox", "width", "height", "role", "aria-label", ...presentation])
  )
    return fallback("viewport attributes require asset rendering.");
  const values = root.attributes.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!values || values.length !== 4 || values.some((v) => !Number.isFinite(v)))
    return fallback("a numeric viewBox is required for editing.");
  const [x, y, width, height] = values;
  const sourceWidth = Number(root.attributes.width ?? width),
    sourceHeight = Number(root.attributes.height ?? height);
  if (
    !(width > 0 && height > 0 && sourceWidth > 0 && sourceHeight > 0) ||
    Math.abs(sourceWidth / sourceHeight - width / height) > 0.00001
  )
    return fallback("viewport scaling requires asset rendering.");
  const shapes = [...root.children].filter((e) => !["title", "desc"].includes(e.name));
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
      !attributes[shape.name] ||
      shape.children.length ||
      !allowed(shape, ["id", ...attributes[shape.name], ...presentation])
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
      (key) => shape.attributes[key] ?? root.attributes[key] ?? defaults[key],
    );
    if (paints && JSON.stringify(paints) !== JSON.stringify(style))
      return fallback("shapes with different paints require asset rendering.");
    paints = style;
    const n = (key: string, defaultValue = 0) => Number(shape.attributes[key] ?? defaultValue);
    const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
      `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`;
    if (shape.name === "path") paths.push(shape.attributes.d ?? "");
    else if (shape.name === "circle" || shape.name === "ellipse") {
      const rx = n(shape.name === "circle" ? "r" : "rx"),
        ry = shape.name === "circle" ? rx : n("ry");
      if (!(rx > 0 && ry > 0)) return fallback("empty ellipse.");
      paths.push(ellipse(n("cx"), n("cy"), rx, ry));
    } else if (shape.name === "rect") {
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
    } else if (shape.name === "line") paths.push(`M ${n("x1")} ${n("y1")} L ${n("x2")} ${n("y2")}`);
    else {
      const points =
        shape.attributes.points
          ?.trim()
          .split(/[\s,]+/)
          .map(Number) ?? [];
      if (points.length < 4 || points.length % 2 || points.some((v) => !Number.isFinite(v)))
        return fallback("invalid polygon points.");
      paths.push(
        `M ${points[0]} ${points[1]} ${points
          .slice(2)
          .map((v, i) => (i % 2 ? `${v}` : `L ${v}`))
          .join(" ")}${shape.name === "polygon" ? " Z" : ""}`,
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
