export type PreviewWindowGeometry = { x: number; y: number; width: number; height: number };
type WorkspaceSize = Pick<PreviewWindowGeometry, "width" | "height">;
export const resizeEdges = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type ResizeEdge = (typeof resizeEdges)[number];

export function constrainGeometry(
  geometry: PreviewWindowGeometry,
  area: WorkspaceSize,
): PreviewWindowGeometry {
  const width = Math.max(Math.min(220, area.width), Math.min(area.width, geometry.width));
  const height = Math.max(Math.min(140, area.height), Math.min(area.height, geometry.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(area.width - width, geometry.x)),
    y: Math.max(0, Math.min(area.height - height, geometry.y)),
  };
}

export function resizeGeometry(
  geometry: PreviewWindowGeometry,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  area: WorkspaceSize,
): PreviewWindowGeometry {
  const left = edge.includes("w");
  const top = edge.includes("n");
  const width =
    edge.includes("e") || left
      ? Math.max(
          Math.min(220, area.width),
          Math.min(
            left ? geometry.x + geometry.width : area.width - geometry.x,
            geometry.width + (left ? -dx : dx),
          ),
        )
      : geometry.width;
  const height =
    edge.includes("s") || top
      ? Math.max(
          Math.min(140, area.height),
          Math.min(
            top ? geometry.y + geometry.height : area.height - geometry.y,
            geometry.height + (top ? -dy : dy),
          ),
        )
      : geometry.height;
  return constrainGeometry(
    {
      x: left ? geometry.x + geometry.width - width : geometry.x,
      y: top ? geometry.y + geometry.height - height : geometry.y,
      width,
      height,
    },
    area,
  );
}
