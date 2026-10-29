import type { BrowserOutput, BrowserState } from "../../../../shared/contracts/browser";
type Frame = Extract<BrowserOutput, { kind: "frame" }>;
export function createBrowserFramePainter(options: {
  canvas(): HTMLCanvasElement | null;
  state(): BrowserState;
  visible(): boolean;
  acknowledge(frameId: number): void;
  painted(view: string): void;
}) {
  let stopped = false;
  let decoding = false;
  let pending: Frame | undefined;
  const draw = (frame: Frame) => {
    if (stopped) return;
    const { data, tabId, viewId, frameId } = frame;
    if (tabId !== options.state().activeTabId || !options.visible()) {
      options.acknowledge(frameId);
      return;
    }
    if (decoding) {
      if (pending) options.acknowledge(pending.frameId);
      pending = frame;
      return;
    }
    decoding = true;
    void createImageBitmap(new Blob([new Uint8Array(data).buffer], { type: "image/jpeg" }))
      .then((bitmap) => {
        try {
          const element = options.canvas();
          const context = element?.getContext("2d", { alpha: false });
          const state = options.state();
          const tab = state.tabs.find((tab) => tab.id === tabId);
          if (
            !stopped &&
            options.visible() &&
            element &&
            context &&
            state.activeTabId === tabId &&
            tab?.viewId === viewId &&
            bitmap.width === tab.width &&
            bitmap.height === tab.height
          ) {
            if (element.width !== bitmap.width) element.width = bitmap.width;
            if (element.height !== bitmap.height) element.height = bitmap.height;
            context.drawImage(bitmap, 0, 0);
            options.painted(`${viewId}:${bitmap.width}:${bitmap.height}`);
          }
        } finally {
          bitmap.close();
        }
      })
      .catch(() => {})
      .finally(() => {
        decoding = false;
        if (!stopped) options.acknowledge(frameId);
        const next = pending;
        pending = undefined;
        if (next && !stopped) draw(next);
      });
  };
  return {
    draw,
    close: () => {
      stopped = true;
      pending = undefined;
    },
  };
}
