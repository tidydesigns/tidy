type Camera = { x: number; y: number; zoom: number };
type Point = { x: number; y: number };

/** Map design coordinates between the two cameras, independent of mounted/culled nodes. */
export function compactViewportTransform(
  preview: Camera,
  editor: Camera,
  previewOrigin: Point,
  editorOrigin: Point,
) {
  const scale = preview.zoom / editor.zoom;
  return {
    x: previewOrigin.x + preview.x - (editorOrigin.x + editor.x) * scale,
    y: previewOrigin.y + preview.y - (editorOrigin.y + editor.y) * scale,
    scale,
  };
}
