import type { DesignNode, DesignPaint } from "@bella/design/document";
import { linearGradientMapping, type Size } from "./gradient-geometry";
export function nodePaints(node: DesignNode): DesignPaint[] {
  if (node.style.paints) return node.style.paints;
  if (node.style.gradientFrom && node.style.gradientTo)
    return [
      {
        id: "legacy-fill",
        type: "linear",
        opacity: 1,
        visible: true,
        angle: node.style.gradientAngle ?? 180,
        stops: [
          { id: "start", position: 0, color: node.style.gradientFrom },
          { id: "end", position: 1, color: node.style.gradientTo },
        ],
      },
    ];
  return node.style.fill || node.style.fillToken
    ? [
        {
          id: "legacy-fill",
          type: "solid",
          color: node.style.fill ?? "#ffffff",
          token: node.style.fillToken,
          opacity: 1,
          visible: true,
        },
      ]
    : [];
}
export function paintStyle(paints: DesignPaint[]): Partial<DesignNode["style"]> {
  return {
    paints,
    fill: undefined,
    fillToken: undefined,
    gradientFrom: undefined,
    gradientTo: undefined,
    gradientAngle: undefined,
  };
}
export function paintBackground(
  paint: DesignPaint,
  tokens: Record<string, string>,
  size: Size = { width: 1, height: 1 },
) {
  if (paint.type === "solid")
    return paint.token ? (tokens[paint.token] ?? paint.color) : paint.color;
  if (paint.type === "image") return undefined;
  if (paint.type === "radial" && paint.rotation) {
    const stops = [...paint.stops]
      .sort((a, b) => a.position - b.position)
      .map(
        (stop) =>
          `<stop offset="${stop.position}" stop-color="${stop.token ? (tokens[stop.token] ?? stop.color) : stop.color}"/>`,
      )
      .join("");
    // A transformed unit circle preserves rotated ellipses without rotating/clipping the fill rectangle.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" preserveAspectRatio="none"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${paint.centerX * size.width} ${paint.centerY * size.height}) rotate(${paint.rotation}) scale(${paint.radiusX * size.width} ${paint.radiusY * size.height})">${stops}</radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  const mapping =
    paint.type === "linear" && paint.start && paint.end
      ? linearGradientMapping(paint, size)
      : undefined;
  const stops = [...paint.stops]
    .sort((a, b) => a.position - b.position)
    .map(
      (stop) =>
        `${stop.token ? (tokens[stop.token] ?? stop.color) : stop.color} ${(mapping ? mapping.position(stop.position) : stop.position) * 100}%`,
    )
    .join(", ");
  return paint.type === "linear"
    ? `linear-gradient(${mapping?.angle ?? paint.angle}deg, ${stops})`
    : `radial-gradient(ellipse ${paint.radiusX * 100}% ${paint.radiusY * 100}% at ${paint.centerX * 100}% ${paint.centerY * 100}%, ${stops})`;
}
export function mapPaintTokens<T extends DesignPaint>(
  paints: T[] | undefined,
  resolve: (name: string, color: string) => { token?: string; color: string },
) {
  return paints?.map((paint) =>
    paint.type === "solid"
      ? { ...paint, ...(paint.token ? resolve(paint.token, paint.color) : {}) }
      : paint.type === "linear" || paint.type === "radial"
        ? {
            ...paint,
            stops: paint.stops.map((stop) => ({
              ...stop,
              ...(stop.token ? resolve(stop.token, stop.color) : {}),
            })),
          }
        : paint,
  ) as T[] | undefined;
}
export function convertPaint(paint: DesignPaint, type: DesignPaint["type"]): DesignPaint {
  if (paint.type === type) return paint;
  const firstStop =
    paint.type === "linear" || paint.type === "radial"
      ? [...paint.stops].sort((a, b) => a.position - b.position)[0]
      : undefined;
  const base = {
      id: paint.id,
      opacity: paint.opacity,
      visible: paint.visible,
      blendMode: paint.blendMode,
    },
    color = paint.type === "solid" ? paint.color : (firstStop?.color ?? "#ffffff");
  const stops =
    paint.type === "linear" || paint.type === "radial"
      ? paint.stops
      : [
          {
            id: "start",
            position: 0,
            color,
            token: paint.type === "solid" ? paint.token : undefined,
          },
          { id: "end", position: 1, color: "#1e1e1e" },
        ];
  return type === "solid"
    ? { ...base, type, color, token: firstStop?.token }
    : type === "linear"
      ? { ...base, type, stops, angle: 180 }
      : type === "radial"
        ? { ...base, type, stops, centerX: 0.5, centerY: 0.5, radiusX: 0.5, radiusY: 0.5 }
        : { ...base, type, fit: "cover", positionX: 50, positionY: 50 };
}
