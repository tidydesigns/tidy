import { expect, test } from "bun:test";
import { authReturnPath } from "../auth-return-path";
import {
  canReadAttachment,
  MAX_IMAGE_BYTES,
  MAX_REQUEST_BYTES,
  readUploadForm,
  validateImages,
  validateSignature,
} from "./validation";

const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "screen.png", {
  type: "image/png",
});

test("attachments reject unsupported, empty, oversized and excessive files", () => {
  expect(() => validateImages([png])).not.toThrow();
  expect(() => validateImages([])).toThrow();
  expect(() => validateImages([png, png, png, png])).toThrow();
  expect(() =>
    validateImages([new File(["<svg/>"], "image.svg", { type: "image/svg+xml" })]),
  ).toThrow();
  expect(() => validateImages([new File([], "empty.png", { type: "image/png" })])).toThrow();
  expect(() =>
    validateImages([
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.png", { type: "image/png" }),
    ]),
  ).toThrow();
});

test("file signatures must match the declared image format", () => {
  expect(() => validateSignature("image/png", new Uint8Array(pngSignature))).not.toThrow();
  expect(() => validateSignature("image/jpeg", new Uint8Array([255, 216, 255, 224]))).not.toThrow();
  expect(() =>
    validateSignature("image/webp", new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])),
  ).not.toThrow();
  expect(() => validateSignature("image/png", new TextEncoder().encode("<html>"))).toThrow();
  expect(() => validateSignature("image/jpeg", new Uint8Array(pngSignature))).toThrow();
});
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

test("private images require ownership or a verified allowlisted reviewer", () => {
  const user = { id: "reader", email: "Reviewer@Example.com", emailVerified: true };
  expect(canReadAttachment("reader", { ...user, emailVerified: false }, "")).toBe(true);
  expect(canReadAttachment("owner", user, " other@example.com, reviewer@example.com ")).toBe(true);
  expect(
    canReadAttachment("owner", { ...user, emailVerified: false }, "reviewer@example.com"),
  ).toBe(false);
  expect(canReadAttachment("owner", user, "")).toBe(false);
  expect(canReadAttachment("owner", user, "notreviewer@example.com")).toBe(false);
});

test("multipart parsing accepts files and limits chunked bodies without Content-Length", async () => {
  const body = new FormData();
  body.set("images", png);
  const form = await readUploadForm(
    new Request("https://app.example/api", { method: "POST", body }),
  );
  expect((form.get("images") as File).size).toBe(png.size);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readUploadForm(
      new Request("https://app.example/api", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=test" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
  ).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
});

test("login only returns to an attachment path, never an external URL", () => {
  const path = "/api/feedback/attachments/12345678-1234-4123-8123-123456789012/0";
  expect(authReturnPath(path, "/")).toBe(path);
  for (const value of [
    "https://evil.example" + path,
    "//evil.example",
    path + "?redirect=https://evil.example",
    path + "/../..",
  ])
    expect(authReturnPath(value, "/")).toBe("/");
});

test("multipart feedback rejects encoded and aborted bodies", async () => {
  const headers = {
    "Content-Type": "multipart/form-data; boundary=test",
    "Content-Encoding": "gzip",
  };
  await expect(
    readUploadForm(
      new Request("https://app.example/api", { method: "POST", headers, body: "encoded" }),
    ),
  ).rejects.toMatchObject({ status: 415 });
  const controller = new AbortController();
  let canceled = false;
  const stream = new ReadableStream({
    cancel() {
      canceled = true;
    },
  });
  const request = new Request("https://app.example/api", {
    method: "POST",
    headers: { "Content-Type": headers["Content-Type"] },
    body: stream,
    signal: controller.signal,
    duplex: "half",
  } as RequestInit);
  const reading = readUploadForm(request);
  controller.abort();
  await expect(reading).rejects.toMatchObject({ status: 408 });
  expect(canceled).toBe(true);
});
