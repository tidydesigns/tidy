import { afterEach, describe, expect, test } from "bun:test";
import { DEVELOPMENT_EXTENSION_ID } from "@bella/design/extension";
import { MAX_CAPTURE_BYTES } from "@bella/design/web-capture";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  readCaptureBody,
} from "./http";

const oldIds = process.env.BELLA_EXTENSION_IDS;
afterEach(() => {
  if (oldIds === undefined) delete process.env.BELLA_EXTENSION_IDS;
  else process.env.BELLA_EXTENSION_IDS = oldIds;
});
const origin = `chrome-extension://${DEVELOPMENT_EXTENSION_ID}`;
const request = (from: string, header = "1") =>
  new Request("https://app.tidydesign.co/api/extension/import", {
    method: "POST",
    headers: { origin: from, "x-bella-extension": header },
  });

describe("extension HTTP boundary", () => {
  test("requires an exact configured extension origin and request header for writes", () => {
    delete process.env.BELLA_EXTENSION_IDS;
    expect(extensionRequestAllowed(request(origin))).toBe(true);
    expect(extensionRequestAllowed(request(`${origin}.evil.test`))).toBe(false);
    expect(extensionRequestAllowed(request("https://evil.test"))).toBe(false);
    expect(extensionRequestAllowed(request(origin, ""))).toBe(false);
    expect(
      extensionRequestAllowed(
        new Request("https://app.tidydesign.co/api/extension/import", {
          method: "POST",
          headers: { "x-bella-extension": "1" },
        }),
      ),
    ).toBe(false);
  });
  test("store IDs replace the development allowlist and rejected origins get no CORS grant", () => {
    process.env.BELLA_EXTENSION_IDS = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(extensionPreflight(request(origin)).status).toBe(403);
    expect(extensionHeaders(request(origin)).has("Access-Control-Allow-Origin")).toBe(false);
    const trusted = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(extensionHeaders(request(trusted)).get("Access-Control-Allow-Origin")).toBe(trusted);
  });
  test("enforces streaming size limits even with no content length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CAPTURE_BYTES + 1));
        controller.close();
      },
    });
    const oversized = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await expect(readCaptureBody(oversized)).rejects.toThrow("16 MB");
    expect(
      await readCaptureBody(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"test":true}',
        }),
      ),
    ).toEqual({ test: true });
  });
});
