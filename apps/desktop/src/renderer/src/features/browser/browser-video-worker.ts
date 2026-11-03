import {
  browserVideoPacket,
  type BrowserFrame,
  type VideoWorkerOutput,
} from "../../../../shared/browser-video";

const pending = new Map<number, Pick<BrowserFrame, "tabId" | "viewId" | "frameId">>();
let decoder: VideoDecoder | undefined;
let view = "";
let codec = "";
const post = (message: VideoWorkerOutput, transfer: Transferable[] = []) =>
  postMessage(message, { transfer });

function reset() {
  if (decoder?.state !== "closed") decoder?.close();
  decoder = undefined;
  for (const frame of pending.values()) post({ kind: "ack", frameId: frame.frameId });
  pending.clear();
}

onmessage = (event: MessageEvent<BrowserFrame>) => {
  const source = event.data;
  try {
    const packet = browserVideoPacket(source.data);
    const nextView = `${source.tabId}:${source.viewId}`;
    if (view !== nextView || (packet.codec && packet.codec !== codec)) {
      reset();
      view = nextView;
    }
    if (!decoder) {
      if (!packet.key || !packet.codec) throw new Error("Browser video needs a keyframe.");
      codec = packet.codec;
      decoder = new VideoDecoder({
        output(frame) {
          const source = pending.get(frame.timestamp);
          pending.delete(frame.timestamp);
          if (!source) {
            frame.close();
            return;
          }
          post(
            {
              kind: "decoded",
              source: { tabId: source.tabId, viewId: source.viewId, frameId: source.frameId },
              frame,
            },
            [frame],
          );
        },
        error(error) {
          reset();
          post({ kind: "error", message: error.message });
        },
      });
      decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
    }
    if (pending.size >= 16 || decoder.decodeQueueSize > 8)
      throw new Error("Browser video decoder fell behind.");
    pending.set(source.frameId, {
      tabId: source.tabId,
      viewId: source.viewId,
      frameId: source.frameId,
    });
    decoder.decode(
      new EncodedVideoChunk({
        type: packet.key ? "key" : "delta",
        timestamp: source.frameId,
        data: packet.bytes,
      }),
    );
  } catch (error) {
    reset();
    post({ kind: "ack", frameId: source.frameId });
    post({
      kind: "error",
      message: error instanceof Error ? error.message : "Browser video decode failed.",
    });
  }
};
