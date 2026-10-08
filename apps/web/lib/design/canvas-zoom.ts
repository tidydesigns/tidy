const WHEEL_ZOOM_RATE = 0.0015;
const PINCH_SENSITIVITY = 5;

export function wheelZoomFactor(deltaY: number, pinch: boolean): number {
  return pinch ? Math.exp(-deltaY * WHEEL_ZOOM_RATE * PINCH_SENSITIVITY) : 1;
}

export function gestureZoomFactor(scale: number, previousScale: number): number {
  return Math.pow(scale / previousScale, PINCH_SENSITIVITY);
}
