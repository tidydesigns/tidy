import { ZodError } from "zod";
import { figmaClipboardBytes, decodeFigma, convertFigma, figmaPages } from "@tidy/design/figma";
self.onmessage = (
  event: MessageEvent<{
    bytes?: Uint8Array;
    html?: string;
    name?: string;
    pages?: string[];
    inspect?: boolean;
  }>,
) => {
  try {
    const bytes = event.data.bytes ?? figmaClipboardBytes(event.data.html ?? "");
    const document = decodeFigma(bytes);
    if (event.data.inspect) {
      self.postMessage({ pages: figmaPages(document) });
      return;
    }
    const result = convertFigma(document, event.data.name, event.data.pages);
    self.postMessage(
      { result },
      { transfer: result.assets.map((asset) => asset.bytes.buffer as ArrayBuffer) },
    );
  } catch (cause) {
    // Structured cloning Error retains its original stack and cause across the
    // local worker boundary; presentation copy travels separately.
    self.postMessage({
      error: cause,
      message:
        cause instanceof ZodError
          ? "This design contains unsupported geometry or exceeds the import limits. Try importing fewer pages."
          : "Could not read this Figma design. Try exporting a new .fig copy.",
    });
  }
};
