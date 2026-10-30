import { browserOutputSchema, type BrowserOutput } from "../../shared/contracts/browser";

type BrowserFrame = Extract<BrowserOutput, { kind: "frame" }>;
const headerSize = 80;

export function encodeBrowserFrame(frame: BrowserFrame) {
  const header = Buffer.alloc(headerSize);
  header.write(frame.tabId, 0, 36, "ascii");
  header.write(frame.viewId, 36, 36, "ascii");
  header.writeDoubleBE(frame.frameId, 72);
  return Buffer.concat([header, frame.data]);
}

export function decodeBrowserFrame(frame: Buffer) {
  if (frame.length < headerSize) return null;
  const parsed = browserOutputSchema.safeParse({
    kind: "frame",
    tabId: frame.subarray(0, 36).toString("ascii"),
    viewId: frame.subarray(36, 72).toString("ascii"),
    frameId: frame.readDoubleBE(72),
    data: frame.subarray(headerSize),
  });
  return parsed.success && parsed.data.kind === "frame" ? parsed.data : null;
}
