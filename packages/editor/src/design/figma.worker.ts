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
    self.postMessage({
      error:
        cause instanceof ZodError
          ? "This design contains unsupported geometry or exceeds the import limits. Try importing fewer pages."
          : cause instanceof Error
            ? cause.message.slice(0, 500)
            : "Could not read this Figma design.",
    });
  }
};
