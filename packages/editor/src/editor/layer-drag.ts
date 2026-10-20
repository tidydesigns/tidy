import type { DesignDocument, DesignNode } from "../design/document";
import { boundingBox, createTranslationSnapState, type SnapBox } from "../design/snapping";
import type { snapTranslation } from "../design/snapping";
import { prepareSnapIndex } from "../design/snap-index";
import { renderedParentSize } from "../design/canvas-geometry";
import { canvasElements } from "./canvas-elements";
import type { CanvasView } from "../design/canvas-culling";

/** Measure snapping once per actual drag, never for selection-only clicks. */
export function measureLayerDrag({
  rootIds,
  nodesById,
  canvas,
  view,
}: {
  rootIds: readonly string[];
  nodesById: ReadonlyMap<string, DesignNode>;
  canvas: HTMLElement | null;
  view: CanvasView;
}) {
  const roots = new Set(rootIds);
  const scopes = new Set(rootIds.map((id) => nodesById.get(id)?.parentId ?? null));
  const snapState = createTranslationSnapState();
  const selectedBoxes: SnapBox[] = [],
    candidates: SnapBox[] = [];
  const parents = new Map<string, { width: number; height: number }>();
  const rect = canvas?.getBoundingClientRect();
  if (!rect) return { bounds: null, candidates, parents, snapState };
  for (const [id, element] of canvasElements(canvas)) {
    const node = nodesById.get(id);
    if (!roots.has(id) && (!node?.visible || !(scopes.has(node.parentId) || scopes.has(id))))
      continue;
    const box = element.getBoundingClientRect();
    if (
      !roots.has(id) &&
      (box.width <= 0 ||
        box.height <= 0 ||
        box.right < rect.left ||
        box.left > rect.right ||
        box.bottom < rect.top ||
        box.top > rect.bottom)
    )
      continue;
    const bounds = {
      x: (box.left - rect.left - view.x) / view.zoom,
      y: (box.top - rect.top - view.y) / view.zoom,
      width: box.width / view.zoom,
      height: box.height / view.zoom,
    };
    if (roots.has(id)) {
      selectedBoxes.push(bounds);
      parents.set(id, renderedParentSize(element));
    } else candidates.push(bounds);
  }
  if (candidates.length >= 128) prepareSnapIndex(candidates);
  return { bounds: boundingBox(selectedBoxes), candidates, parents, snapState };
}

type DragOrigin = { pointerId: number; id: string; x: number; y: number; ids: string[] };
export type LayerDrag = DragOrigin &
  (
    | { kind: "pending" }
    | {
        kind: "moving";
        geometry: ReturnType<typeof measureLayerDrag>;
        preview: {
          content: DesignDocument;
          delta: ReturnType<typeof snapTranslation>;
          bypass: boolean;
          zoom: number;
        } | null;
      }
  );
export type MovingLayerDrag = Extract<LayerDrag, { kind: "moving" }>;

/** A zero-distance pointer event is still a click; an active drag reuses its geometry. */
export function activateLayerDrag(
  drag: LayerDrag,
  x: number,
  y: number,
  measure: (ids: string[]) => ReturnType<typeof measureLayerDrag>,
): MovingLayerDrag | null {
  if (drag.kind === "moving") return drag;
  if (x === drag.x && y === drag.y) return null;
  return { ...drag, kind: "moving", geometry: measure(drag.ids), preview: null };
}
