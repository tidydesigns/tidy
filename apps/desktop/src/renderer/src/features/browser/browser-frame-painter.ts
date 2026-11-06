import type { BrowserOutput, BrowserState } from "../../../../shared/contracts/browser";
import { browserFrameSize } from "../../../../shared/browser-viewport";
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
    const state = options.state();
    if (
      tabId !== state.activeTabId ||
      state.tabs.find((tab) => tab.id === tabId)?.viewId !== viewId ||
      !options.visible()
    ) {
      options.acknowledge(frameId);
      return;
    }
    if (decoding) {
      if (pending) options.acknowledge(pending.frameId);
      pending = frame;
      return;
    }
    decoding = true;
    const bytes =
      data.buffer instanceof ArrayBuffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    void createImageBitmap(
      new Blob([bytes], { type: state.presentation === "native" ? "image/png" : "image/jpeg" }),
    )
      .then((bitmap) => {
        try {
          const element = options.canvas();
          const context = element?.getContext("2d", { alpha: false });
          const state = options.state();
          const tab = state.tabs.find((tab) => tab.id === tabId);
          const size = tab && browserFrameSize(tab);
          if (
            !stopped &&
            options.visible() &&
            element &&
            context &&
            state.activeTabId === tabId &&
            tab?.viewId === viewId &&
            size &&
            (state.presentation === "native" ||
              (Math.abs(bitmap.width - size.width) <= 1 &&
                Math.abs(bitmap.height - size.height) <= 1))
          ) {
            if (element.width !== bitmap.width) element.width = bitmap.width;
            if (element.height !== bitmap.height) element.height = bitmap.height;
            context.drawImage(bitmap, 0, 0);
            options.painted(`${viewId}:${tab.width}:${tab.height}`);
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
