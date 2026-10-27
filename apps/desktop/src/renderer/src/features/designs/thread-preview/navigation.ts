import { wheelZoomFactor } from "@tidy/editor/design/canvas-zoom";
import type {
  PreviewViewport,
  PreviewBounds,
} from "@tidy/editor/components/files/document-preview";

export type PreviewCamera = Pick<PreviewViewport, "x" | "y" | "zoom">;
export type PreviewCameraMemory = { current?: PreviewCamera };
export type PreviewSize = Pick<PreviewViewport, "width" | "height">;
export type { PreviewBounds } from "@tidy/editor/components/files/document-preview";

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
