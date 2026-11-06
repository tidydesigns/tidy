import type { BrowserOutput } from "./contracts/browser";

export type BrowserFrame = Extract<BrowserOutput, { kind: "frame" }>;
export type VideoWorkerOutput =
  | {
      kind: "decoded";
      frame: VideoFrame;
      source: Pick<BrowserFrame, "tabId" | "viewId" | "frameId">;
    }
  | { kind: "ack"; frameId: number }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export function browserVideoPacket(data: Uint8Array) {
  if (data.length <= 16 || data[0] !== 1 || data[10] !== 0 || data[11] !== 1 || data[12] !== 1)
    throw new Error("Unsupported browser video packet.");
  const key = (data[1] & 1) !== 0;
  const bytes = data.subarray(16);
  let codec: string | undefined;
  if (key)
    for (let i = 0; i + 6 < bytes.length; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 31) === 7) {
        codec = `avc1.${[bytes[i + 4], bytes[i + 5], bytes[i + 6]].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
        break;
      }
    }
  return { key, bytes, codec };
}
