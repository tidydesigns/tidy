import { captureElement } from "./capture";
import { MAX_CAPTURE_BYTES } from "@bella/design/capture-source";
import type { WebCapture } from "@bella/design/web-capture";
import type { CaptureViewport } from "@bella/design/capture-effects";

export async function captureSelection(
  elements: Element[],
  screenshot?: string,
  viewport?: CaptureViewport,
  screenshotValid?: () => boolean,
): Promise<WebCapture> {
  if (!elements.length || elements.some((element) => !element.isConnected))
    throw new Error("A selected element disappeared. Select it again.");
  let result: WebCapture | undefined;
  let x = 0,
    y = 0,
    rowHeight = 0;
  const warnings = new Set<string>();
  const deadline = performance.now() + 20000;
  for (const element of elements) {
    const capture = await captureElement(element, "element", screenshot, viewport, {
      screenshotValid,
      deadline,
    });
    for (const node of capture.document.nodes) {
      if (node.parentId !== null) continue;
      if (x && x + node.box.width > 10000) {
        x = 0;
        y += rowHeight + 120;
        rowHeight = 0;
      }
      if (y > 100000) throw new Error("This selection is too large. Select fewer elements.");
      node.box.x = x;
      node.box.y = y;
      x += node.box.width + 120;
      rowHeight = Math.max(rowHeight, node.box.height);
    }
    for (const { message } of capture.document.warnings) warnings.add(message);
    if (!result) result = capture;
    else {
      result.document.nodes.push(...capture.document.nodes);
      result.assets.push(...capture.assets);
    }
    result.document.warnings = [...warnings].map((message) => ({ message }));
    if (result.document.nodes.length > 5000 || result.assets.length > 100 || warnings.size > 500)
      throw new Error("This selection exceeds the capture limits. Select fewer elements.");
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CAPTURE_BYTES - 1000)
      throw new Error("This selection is too large. Select fewer elements.");
  }
  if (elements.some((element) => !element.isConnected))
    throw new Error("A selected element disappeared during capture. Select it again.");
  if (elements.length > 1)
    result!.title = `${elements.length} elements: ${document.title || "Website capture"}`.slice(
      0,
      120,
    );
  result!.document.warnings = [...warnings].map((message) => ({ message }));
  return result!;
}
