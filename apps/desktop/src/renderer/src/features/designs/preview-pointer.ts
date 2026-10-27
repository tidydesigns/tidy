import { gestureMoved } from "./preview-navigation";

export function createPreviewPointerGesture() {
  let pointer: { id: number; x: number; y: number; moved: boolean; pan: boolean } | undefined;
  return {
    start(id: number, x: number, y: number, pan: boolean) {
      pointer = { id, x, y, moved: false, pan };
      return pan;
    },
    move(id: number, x: number, y: number) {
      if (!pointer || id !== pointer.id) return;
      const dx = x - pointer.x,
        dy = y - pointer.y;
      if (!pointer.moved && !gestureMoved(dx, dy)) return;
      pointer.moved = true;
      if (!pointer.pan) return { x: 0, y: 0 };
      pointer.x = x;
      pointer.y = y;
      return { x: dx, y: dy };
    },
    finish(id: number, cancelled: boolean) {
      if (!pointer || pointer.id !== id) return;
      const suppress = cancelled || pointer.moved || pointer.pan;
      pointer = undefined;
      return suppress;
    },
  };
}
