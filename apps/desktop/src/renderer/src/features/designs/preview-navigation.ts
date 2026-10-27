import { wheelZoomFactor } from "@tidy/editor/design/canvas-zoom";

export type PreviewCamera = { x: number; y: number; zoom: number };
export type PreviewCameraMemory = { current?: PreviewCamera };
export type PreviewSize = { width: number; height: number };
export type PreviewBounds = PreviewSize & { x: number; y: number };
export const resizeEdges = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type ResizeEdge = (typeof resizeEdges)[number];

export function fitPreview(bounds: PreviewBounds, size: PreviewSize): PreviewCamera {
  const zoom = Math.min(size.width / bounds.width, size.height / bounds.height);
  return {
    zoom,
    x: (size.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (size.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}

export function zoomPreview(camera: PreviewCamera, x: number, y: number, factor: number) {
  const zoom = Math.max(0.01, Math.min(16, camera.zoom * factor));
  return {
    zoom,
    x: x - ((x - camera.x) * zoom) / camera.zoom,
    y: y - ((y - camera.y) * zoom) / camera.zoom,
  };
}

export function wheelPreview(
  camera: PreviewCamera,
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey">,
  cursor: { x: number; y: number },
  height: number,
) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  return event.ctrlKey || event.metaKey
    ? zoomPreview(camera, cursor.x, cursor.y, wheelZoomFactor(event.deltaY * unit, true))
    : { ...camera, x: camera.x - event.deltaX * unit, y: camera.y - event.deltaY * unit };
}

export function gestureMoved(dx: number, dy: number) {
  return Math.hypot(dx, dy) >= 5;
}

export function constrainGeometry(geometry: PreviewBounds, area: PreviewSize): PreviewBounds {
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
  geometry: PreviewBounds,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  area: PreviewSize,
): PreviewBounds {
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
