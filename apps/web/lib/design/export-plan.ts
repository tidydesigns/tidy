import type { DesignDocument, DesignNode } from "./document";
export type ExportFormat = "png" | "webp" | "svg" | "pdf";
export type ExportRequest = {
  ids: string[];
  format: ExportFormat;
  scale: number;
  mode: "selection" | "batch";
};
export type ExportBounds = { x: number; y: number; width: number; height: number };
export type ExportMatrix = [number, number, number, number, number, number];
export function exportRoots(document: DesignDocument, ids: readonly string[]) {
  const byId = new Map(document.nodes.map((n) => [n.id, n])),
    selected = new Set(ids);
  const roots = document.nodes
    .filter((n) => selected.has(n.id))
    .filter((n) => {
      let parent = byId.get(n.parentId ?? "");
      while (parent) {
        if (selected.has(parent.id)) return false;
        parent = byId.get(parent.parentId ?? "");
      }
      return true;
    });
  if (!roots.length) throw new Error("Select at least one layer to export.");
  if (roots.length > 50) throw new Error("Export up to 50 selected layers at a time.");
  if (roots.some((n) => !n.visible)) throw new Error("Show selected layers before exporting them.");
  return roots;
}
export function exportDimensions(bounds: ExportBounds, scale: number) {
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 4)
    throw new Error("Choose an export scale between 0.25× and 4×.");
  const width = Math.max(1, Math.ceil(bounds.width * scale)),
    height = Math.max(1, Math.ceil(bounds.height * scale));
  if (
    !Number.isFinite(width + height) ||
    width > 16384 ||
    height > 16384 ||
    width * height > 64_000_000
  )
    throw new Error(
      "Export exceeds 64 megapixels or 16,384 pixels on one side. Choose a smaller scale.",
    );
  return { width, height };
}
export function exportFilename(
  name: string,
  scale: number,
  format: ExportFormat | "zip",
  duplicate = 1,
) {
  const base =
    name
      .normalize("NFKC")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "layer";
  return `${base}${duplicate > 1 ? `-${duplicate}` : ""}${scale === 1 ? "" : `@${scale}x`}.${format}`;
}
export function exportNames(nodes: readonly DesignNode[], scale: number, format: ExportFormat) {
  const used = new Set<string>();
  return nodes.map((n) => {
    let duplicate = 1,
      name = exportFilename(n.name, scale, format);
    while (used.has(name.toLowerCase())) name = exportFilename(n.name, scale, format, ++duplicate);
    used.add(name.toLowerCase());
    return name;
  });
}
export function matrixMultiply(a: ExportMatrix, b: ExportMatrix): ExportMatrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function transformedExportBounds(box: ExportBounds, m: ExportMatrix): ExportBounds {
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }));
  const x = Math.min(...corners.map((p) => p.x)),
    y = Math.min(...corners.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...corners.map((p) => p.x)) - x,
    height: Math.max(...corners.map((p) => p.y)) - y,
  };
}
export function unionExportBounds(boxes: readonly ExportBounds[]): ExportBounds {
  const x = Math.floor(Math.min(...boxes.map((b) => b.x))),
    y = Math.floor(Math.min(...boxes.map((b) => b.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width))) - x),
    height: Math.max(1, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height))) - y),
  };
}
