import {
  browserVideoPacket,
  type BrowserFrame,
  type VideoWorkerOutput,
} from "../../../../shared/browser-video";

const pending = new Map<number, Pick<BrowserFrame, "tabId" | "viewId" | "frameId">>();
const queued: { source: BrowserFrame; packet: ReturnType<typeof browserVideoPacket> }[] = [];
let queuedBytes = 0;
let decoder: VideoDecoder | undefined;
let view = "";
let codec = "";
const post = (message: VideoWorkerOutput, transfer: Transferable[] = []) =>
  postMessage(message, { transfer });

function reset() {
  const previous = decoder;
  decoder = undefined;
  if (previous?.state !== "closed") previous?.close();
  for (const { source } of queued) post({ kind: "ack", frameId: source.frameId });
  queued.length = 0;
  queuedBytes = 0;
  for (const frame of pending.values()) post({ kind: "ack", frameId: frame.frameId });
  pending.clear();
}

function fail(error: unknown) {
  reset();
  if (error instanceof DOMException && error.name === "NotSupportedError") {
    post({ kind: "unsupported" });
    return;
  }
  post({
    kind: "error",
    message: error instanceof Error ? error.message : "Browser video decode failed.",
  });
}

function drain() {
  try {
    while (decoder?.state === "configured" && decoder.decodeQueueSize < 4 && pending.size < 16) {
      const next = queued.shift();
      if (!next) return;
      queuedBytes -= next.source.data.byteLength;
      pending.set(next.source.frameId, {
        tabId: next.source.tabId,
        viewId: next.source.viewId,
        frameId: next.source.frameId,
      });
      decoder.decode(
        new EncodedVideoChunk({
          type: next.packet.key ? "key" : "delta",
          timestamp: next.source.frameId,
          data: next.packet.bytes,
        }),
      );
    }
  } catch (error) {
    fail(error);
  }
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
      const current = new VideoDecoder({
        output(frame) {
          if (decoder !== current) {
            frame.close();
            return;
          }
          const source = pending.get(frame.timestamp);
          pending.delete(frame.timestamp);
          if (!source) {
            frame.close();
            return;
          }
          try {
            post(
              {
                kind: "decoded",
                source: { tabId: source.tabId, viewId: source.viewId, frameId: source.frameId },
                frame,
              },
              [frame],
            );
            drain();
          } catch (error) {
            frame.close();
            post({ kind: "ack", frameId: source.frameId });
            fail(error);
          }
        },
        error(error) {
          if (decoder === current) fail(error);
        },
      });
      decoder = current;
      current.ondequeue = () => {
        if (decoder === current) drain();
      };
      current.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
    }
    if (queued.length >= 48 || queuedBytes + source.data.byteLength > 8 * 1024 * 1024)
      throw new Error("Browser video decoder fell behind.");
    queued.push({ source, packet });
    queuedBytes += source.data.byteLength;
    drain();
  } catch (error) {
    post({ kind: "ack", frameId: source.frameId });
    fail(error);
  }
};
