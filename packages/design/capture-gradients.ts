import type { DesignPaint } from "./document";

type Size = { width: number; height: number };
type Color = (value: string) => string | undefined;
const number = "[-+]?(?:\\d*\\.)?\\d+";
/** CSS commas inside color functions do not separate background layers or stops. */
export function splitCssList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    if (value[index] === ")") depth--;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) return [];
  }
  if (depth) return [];
  return [...parts, value.slice(start).trim()];
}
function length(value: string, size: number): number | undefined {
  const match = value.match(new RegExp(`^(${number})(%|px)?$`));
  if (!match || (!match[2] && Number(match[1]) !== 0)) return undefined;
  return Number(match[1]) * (match[2] === "%" ? size / 100 : 1);
}
function angle(value: string, size: Size): number | undefined {
  const match = value.match(new RegExp(`^(${number})(deg|rad|turn|grad)$`));
  if (match)
    return Number(match[1]) * { deg: 1, rad: 180 / Math.PI, turn: 360, grad: 0.9 }[match[2]!]!;
  if (!value.startsWith("to ")) return undefined;
  const sides = value.slice(3).split(/\s+/);
  if (
    sides.length > 2 ||
    new Set(sides).size !== sides.length ||
    sides.some((side) => !["left", "right", "top", "bottom"].includes(side))
  )
    return undefined;
  if (
    (sides.includes("left") && sides.includes("right")) ||
    (sides.includes("top") && sides.includes("bottom"))
  )
    return undefined;
  const x = sides.includes("right") ? 1 : sides.includes("left") ? -1 : 0;
  const y = sides.includes("bottom") ? 1 : sides.includes("top") ? -1 : 0;
  // Corner directions are perpendicular to the opposite corner diagonal.
  return (Math.atan2(x * size.height, -y * size.width) * 180) / Math.PI;
}
function radialGeometry(header: string, size: Size) {
  const [shapeText = "", positionText = "center"] = header.split(/\s*\bat\b\s*/);
  const parts = positionText.trim().split(/\s+/);
  if (parts.length > 2) return;
  let [x = "center", y = "center"] = parts;
  if (["top", "bottom"].includes(x) || ["left", "right"].includes(y)) [x, y] = [y, x];
  const coordinate = (value: string, extent: number, axis: "x" | "y") =>
    value === "center"
      ? extent / 2
      : value === (axis === "x" ? "left" : "top")
        ? 0
        : value === (axis === "x" ? "right" : "bottom")
          ? extent
          : length(value, extent);
  const cx = coordinate(x, size.width, "x"),
    cy = coordinate(y, size.height, "y");
  if (cx === undefined || cy === undefined) return;
  const shapeParts = shapeText.trim().split(/\s+/).filter(Boolean);
  const circle = shapeParts.includes("circle");
  const sizes = shapeParts.filter((part) => part !== "circle" && part !== "ellipse");
  if (shapeParts.includes("circle") && shapeParts.includes("ellipse")) return;
  const keyword = sizes.length ? sizes[0]! : "farthest-corner";
  let rx: number | undefined, ry: number | undefined;
  if (
    sizes.length <= 1 &&
    ["closest-side", "farthest-side", "closest-corner", "farthest-corner"].includes(keyword)
  ) {
    const nearest = keyword.startsWith("closest"),
      choose = nearest ? Math.min : Math.max;
    const dx = choose(Math.abs(cx), Math.abs(size.width - cx)),
      dy = choose(Math.abs(cy), Math.abs(size.height - cy));
    if (circle) rx = ry = keyword.endsWith("corner") ? Math.hypot(dx, dy) : choose(dx, dy);
    else {
      rx = dx;
      ry = dy;
      if (keyword.endsWith("corner")) {
        rx *= Math.SQRT2;
        ry *= Math.SQRT2;
      }
    }
  } else if (sizes.length === 1 && !sizes[0]!.endsWith("%") && !shapeParts.includes("ellipse"))
    rx = ry = length(sizes[0]!, size.width);
  else if (sizes.length === 2 && !circle) {
    rx = length(sizes[0]!, size.width);
    ry = length(sizes[1]!, size.height);
  }
  if (rx === undefined || ry === undefined || rx <= 0 || ry <= 0) return;
  return {
    centerX: cx / size.width,
    centerY: cy / size.height,
    radiusX: rx / size.width,
    radiusY: ry / size.height,
  };
}
function stops(parts: string[], extent: number, color: Color) {
  const result: { color: string; position?: number }[] = [];
  for (const part of parts) {
    const match = part.match(/^(rgba?\([^)]*\)|#[\da-f]+|[a-z]+)(.*)$/i);
    if (!match) return;
    const parsedColor = color(match[1]!);
    if (!parsedColor) return;
    const positions = match[2]!.trim().split(/\s+/).filter(Boolean);
    if (positions.length > 2) return;
    if (!positions.length) result.push({ color: parsedColor });
    for (const position of positions) {
      const pixels = length(position, extent);
      if (pixels === undefined) return;
      result.push({ color: parsedColor, position: pixels / extent });
    }
  }
  if (result.length < 2 || result.length > 20) return;
  result[0]!.position ??= 0;
  result.at(-1)!.position ??= 1;
  let previous = result[0]!.position!;
  for (const stop of result)
    if (stop.position !== undefined) {
      stop.position = Math.max(previous, stop.position);
      previous = stop.position;
    }
  for (let start = 0; start < result.length - 1;) {
    let end = start + 1;
    while (result[end]!.position === undefined) end++;
    for (let index = start + 1; index < end; index++)
      result[index]!.position =
        result[start]!.position! +
        ((result[end]!.position! - result[start]!.position!) * (index - start)) / (end - start);
    start = end;
  }
  // The paint model has bounded stops; unsupported positions retain a capture warning.
  if (
    result.some(
      (stop) => !Number.isFinite(stop.position) || stop.position! < 0 || stop.position! > 1,
    )
  )
    return;
  return result.map((stop, index) => ({ ...stop, id: `stop-${index}`, position: stop.position! }));
}
export function captureGradient(
  value: string,
  size: Size,
  color: Color,
  id = "css-gradient",
): DesignPaint | undefined {
  if (!(size.width > 0 && size.height > 0)) return;
  const match = value.match(/^(linear|radial)-gradient\((.*)\)$/);
  if (!match) return;
  const parts = splitCssList(match[2]!);
  if (parts.length < 2) return;
  const base = { id, visible: true, opacity: 1 };
  if (match[1] === "linear") {
    const direction = angle(parts[0]!, size);
    if (direction !== undefined) parts.shift();
    const degrees = (((direction ?? 180) % 360) + 360) % 360,
      radians = (degrees * Math.PI) / 180;
    const extent =
      Math.abs(size.width * Math.sin(radians)) + Math.abs(size.height * Math.cos(radians));
    const colors = stops(parts, extent, color);
    if (!colors) return;
    return { ...base, type: "linear", angle: degrees, stops: colors };
  }
  const header = /^(?:rgba?\(|#|transparent\b)/i.test(parts[0]!) ? "" : parts.shift()!;
  const geometry = radialGeometry(header, size);
  if (!geometry) return;
  if (
    geometry.centerX < -3 ||
    geometry.centerX > 4 ||
    geometry.centerY < -3 ||
    geometry.centerY > 4 ||
    geometry.radiusX < 0.001 ||
    geometry.radiusX > 3 ||
    geometry.radiusY < 0.001 ||
    geometry.radiusY > 3
  )
    return;
  const colors = stops(parts, geometry.radiusX * size.width, color);
  if (!colors) return;
  return { ...base, type: "radial", ...geometry, stops: colors };
}

/** Convert complete gradient stacks only when their CSS positioning is representable. */
export function captureGradientStack(
  css: CSSStyleDeclaration,
  size: Size,
  color: Color,
): DesignPaint[] | undefined {
  if (!css.backgroundImage || css.backgroundImage === "none") return;
  const backgrounds = splitCssList(css.backgroundImage);
  if (!backgrounds.length || backgrounds.length > 19) return;
  for (const [value, allowed] of [
    [css.backgroundAttachment, ["scroll"]],
    [css.backgroundSize, ["auto", "auto auto"]],
    [css.backgroundPosition, ["0% 0%"]],
    [css.backgroundOrigin, ["padding-box"]],
    [css.backgroundClip, ["border-box", "padding-box"]],
    [css.backgroundBlendMode, ["normal"]],
  ] as const) {
    if (
      value &&
      splitCssList(value).some((entry) => !(allowed as readonly string[]).includes(entry))
    )
      return;
  }
  const paints = backgrounds.map((value, index) =>
    captureGradient(value, size, color, `css-gradient-${index}`),
  );
  return paints.every((paint): paint is DesignPaint => Boolean(paint)) ? paints : undefined;
}
