import { browserOutputSchema, type BrowserOutput } from "../../shared/contracts/browser";

type BrowserFrame = Extract<BrowserOutput, { kind: "frame" }>;
const headerSize = 80;

export function encodeBrowserFrame(frame: BrowserFrame) {
  const header = Buffer.alloc(headerSize);
  header.write(frame.tabId, 0, 36, "ascii");
  header.write(frame.viewId, 36, 36, "ascii");
  header.writeDoubleBE(frame.frameId, 72);
  return Buffer.concat([
    ...(frame.codec === "h264" ? [Buffer.from([0, 84, 86, 49])] : []),
    header,
    frame.data,
  ]);
}

export function decodeBrowserFrame(frame: Buffer) {
  const video = frame.subarray(0, 4).equals(Buffer.from([0, 84, 86, 49]));
  if (video) frame = frame.subarray(4);
  if (frame.length < headerSize) return null;
  const parsed = browserOutputSchema.safeParse({
    kind: "frame",
    ...(video ? { codec: "h264" } : {}),
    tabId: frame.subarray(0, 36).toString("ascii"),
    viewId: frame.subarray(36, 72).toString("ascii"),
    frameId: frame.readDoubleBE(72),
    data: frame.subarray(headerSize),
  });
  return parsed.success && parsed.data.kind === "frame" ? parsed.data : null;
}
