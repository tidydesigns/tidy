import { describe, expect, test } from "bun:test";
import { diagnosticError, errorMessage, isCancellation } from "@tidy/ui/errors";
import { vectorisationError } from "@tidy/editor/design/vectorisation/errors";
import { traceRaster } from "./trace";

const fallback = "Could not vectorise this image.";

describe("vectorisation error messages", () => {
  test("a real contour limit failure explains image complexity and preserves diagnostics", () => {
    const width = 80;
    const data = new Uint8ClampedArray(width * width * 4);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        const hole = x > 3 && y > 3 && x < 76 && y < 76 && x % 6 < 2 && y % 6 < 2;
        data.set([255, 0, 0, hole ? 0 : 255], (y * width + x) * 4);
      }
    let failure: unknown;
    try {
      traceRaster({ width, height: width, data }, "auto");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const notice = vectorisationError(failure);
    expect(errorMessage(notice, fallback)).toBe(
      "This image has too many small details to vectorise. Try cropping to a simpler area.",
    );
    expect(diagnosticError(notice)).toBe(failure);
  });

  test("fully transparent artwork explains the missing visible shapes and preserves diagnostics", () => {
    let failure: unknown;
    try {
      traceRaster({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }, "auto");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const notice = vectorisationError(failure);
    expect(errorMessage(notice, fallback)).toBe(
      "No visible shapes could be traced. Try a clearer or higher-resolution image.",
    );
    expect(diagnosticError(notice)).toBe(failure);
  });

  test.each([
    ["Choose an image under 2 MB.", "under 2 MB"],
    ["Vectorisation supports PNG, JPEG and WebP images.", "Convert this image"],
    ["Vectorisation took too long. Try a simpler image.", "took too long"],
    [
      "This image loses too much detail when vectorised. Try more colours or a cleaner source image.",
      "would lose too much detail",
    ],
  ])("explains the known failure: %s", (reason, expected) => {
    expect(errorMessage(vectorisationError(new Error(reason)), fallback)).toContain(expected);
  });

  test("unexpected failures stay generic and cancellation stays silent", () => {
    const unexpected = new Error("Private implementation details");
    expect(vectorisationError(unexpected)).toBe(unexpected);
    expect(errorMessage(vectorisationError(unexpected), fallback)).toBe(fallback);
    expect(errorMessage(vectorisationError("Private implementation details"), fallback)).toBe(
      fallback,
    );
    const aborted = new DOMException("Vectorisation cancelled.", "AbortError");
    expect(isCancellation(vectorisationError(aborted))).toBe(true);
  });
});
