import type { BrowserOutput, BrowserState } from "../../../../shared/contracts/browser";
import type { VideoWorkerOutput } from "../../../../shared/browser-video";
type Frame = Extract<BrowserOutput, { kind: "frame" }>;
export function createBrowserFramePainter(options: {
  canvas(): HTMLCanvasElement | null;
  state(): BrowserState;
  visible(): boolean;
  acknowledge(frameId: number): void;
  painted(view: string): void;
  resyncVideo(): void;
  disableVideo(): void;
}) {
  let stopped = false;
  let video: Worker | undefined;
  let lastResync = -Infinity;
  let failures = 0;
  const resync = () => {
    if (performance.now() - lastResync > 1000) {
      lastResync = performance.now();
      if (++failures >= 3) options.disableVideo();
      else options.resyncVideo();
    }
  };
  const videoFrame = (frame: Frame) => {
    if (!video) {
      video = new Worker(new URL("./browser-video-worker.ts", import.meta.url), { type: "module" });
      video.onerror = () => {
        video?.terminate();
        video = undefined;
        resync();
      };
      video.onmessage = ({ data }: MessageEvent<VideoWorkerOutput>) => {
        if (data.kind === "ack") {
          options.acknowledge(data.frameId);
          return;
        }
        if (data.kind === "error") {
          resync();
          return;
        }
        const { frame, source } = data;
        try {
          const state = options.state();
          const tab = state.tabs.find((tab) => tab.id === source.tabId);
          const element = options.canvas();
          if (
            stopped ||
            !options.visible() ||
            !element ||
            state.activeTabId !== source.tabId ||
            tab?.viewId !== source.viewId ||
            frame.displayWidth < tab.width ||
            frame.displayHeight < tab.height
          )
            return;
          if (element.width !== tab.width) element.width = tab.width;
          if (element.height !== tab.height) element.height = tab.height;
          element
            .getContext("2d", { alpha: false })
            ?.drawImage(frame, 0, 0, tab.width, tab.height, 0, 0, tab.width, tab.height);
          options.painted(`${source.viewId}:${tab.width}:${tab.height}`);
        } finally {
          frame.close();
          if (!stopped) options.acknowledge(source.frameId);
        }
      };
    }
    const data = new Uint8Array(frame.data);
    video.postMessage({ ...frame, data }, [data.buffer]);
  };
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
    if (frame.codec === "h264") {
      if (typeof VideoDecoder === "undefined") {
        options.acknowledge(frameId);
        options.disableVideo();
        return;
      }
      videoFrame(frame);
      return;
    }
    video?.terminate();
    video = undefined;
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
      video?.terminate();
      pending = undefined;
    },
  };
}
