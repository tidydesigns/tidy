import { afterEach, describe, expect, test } from "bun:test";
import { DEVELOPMENT_EXTENSION_ID } from "@tidy/design/extension";
import { MAX_CAPTURE_BYTES } from "@tidy/design/web-capture";
import {
  extensionHeaders,
  extensionPreflight,
  extensionRequestAllowed,
  readCaptureBody,
  extensionError,
  CaptureBodyError,
} from "./http";
import { PublicActionError } from "@/lib/security/public-error";

const oldIds = process.env.BELLA_EXTENSION_IDS;
const oldMode = process.env.NODE_ENV;
afterEach(() => {
  if (oldIds === undefined) delete process.env.BELLA_EXTENSION_IDS;
  else process.env.BELLA_EXTENSION_IDS = oldIds;
  if (oldMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Object.assign(process.env, { NODE_ENV: oldMode });
});
const origin = `chrome-extension://${DEVELOPMENT_EXTENSION_ID}`;
const request = (from: string, header = "1") =>
  new Request("https://app.tidydesign.co/api/extension/import", {
    method: "POST",
    headers: { origin: from, "x-tidy-extension": header },
  });

describe("extension HTTP boundary", () => {
  test("production writes require an explicit extension allowlist", () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.BELLA_EXTENSION_IDS;
    expect(extensionRequestAllowed(request(origin))).toBe(false);
    process.env.BELLA_EXTENSION_IDS = DEVELOPMENT_EXTENSION_ID;
    expect(extensionRequestAllowed(request(origin))).toBe(true);
  });
  test("unexpected server errors never expose infrastructure details", () => {
    expect(
      extensionError(new Error("postgres://operator:private-password@internal-db/customer")),
    ).toEqual({ message: "Could not import webpage. Try again later.", status: 500 });
    expect(extensionError(new PublicActionError("File not found or access denied."))).toEqual({
      message: "File not found or access denied.",
      status: 403,
    });
    expect(extensionError(new CaptureBodyError("Capture exceeds 16 MB.", 413)).status).toBe(413);
  });
  test("malformed JSON returns a deliberate input error", async () => {
    await expect(
      readCaptureBody(
        new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toThrow("valid JSON");
  });
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
          headers: { "x-tidy-extension": "1" },
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
    expect(extensionPreflight(request(trusted)).headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, X-Tidy-Extension",
    );
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
  test("shares the app theme with the extension and ignores invalid cookie values", () => {
    for (const [cookie, expected] of [
      ["tidy-theme=dark", "dark"],
      ["other=value; tidy-theme=light", "light"],
      ["tidy-theme=system", "system"],
      ["tidy-theme=invalid", "system"],
      ["", "system"],
    ]) {
      const headers = extensionHeaders(
        new Request("http://localhost:3000/api/extension/account", { headers: { origin, cookie } }),
      );
      expect(headers.get("X-Tidy-Theme")).toBe(expected);
      expect(headers.get("Access-Control-Expose-Headers")).toBe("X-Tidy-Theme, Retry-After");
    }
  });
});
