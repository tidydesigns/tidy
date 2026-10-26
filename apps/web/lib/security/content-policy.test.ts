import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";
import { pageContentPolicy } from "./content-policy";

test("page responses use fresh nonces and replace supplied policy headers", () => {
  const request = new NextRequest("https://app.example.test/login", {
    headers: { "x-tidy-nonce": "supplied", "content-security-policy": "supplied" },
  });
  const first = proxy(request);
  const second = proxy(request);
  const nonce = first.headers.get("x-middleware-request-x-tidy-nonce")!;
  expect(nonce).not.toBe("supplied");
  expect(nonce).not.toBe(second.headers.get("x-middleware-request-x-tidy-nonce"));
  const policy = first.headers.get("Content-Security-Policy")!;
  expect(policy).toContain(`'nonce-${nonce}'`);
  expect(policy).toBe(first.headers.get("x-middleware-request-content-security-policy")!);
  expect(first.headers.get("Cache-Control")).toBe("private, no-store");
});

test("production policy retains editor resources without enabling inline scripts", () => {
  const policy = pageContentPolicy("fixture");
  expect(policy).toContain("script-src-attr 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("worker-src 'self' blob:");
  expect(policy).toContain("font-src 'self' data: blob: https://fonts.gstatic.com");
  const scripts = policy
    .split(";")
    .find((directive) => directive.trim().startsWith("script-src "))!;
  expect(scripts).not.toContain("'unsafe-inline'");
  expect(scripts).not.toContain("'unsafe-eval'");
  expect(scripts).toContain("'wasm-unsafe-eval'");
  expect(pageContentPolicy("fixture", true)).toContain("'unsafe-eval'");
  expect(() => pageContentPolicy("invalid;value")).toThrow();
});
