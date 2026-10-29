import { expect, test } from "bun:test";
import {
  browserURL,
  browserInputSchema,
  browserCommandSchema,
  isDevelopmentURL,
  browserStateSchema,
  emptyBrowserState,
} from "./browser";

test("browser addresses keep remote loopback explicit and reject privileged schemes and credentials", () => {
  expect(browserURL("localhost:3000/path?q=1")).toBe("http://localhost:3000/path?q=1");
  expect(browserURL("127.0.0.1:5173")).toBe("http://127.0.0.1:5173/");
  expect(browserURL("[::1]:8080")).toBe("http://[::1]:8080/");
  expect(browserURL("example.com")).toBe("https://example.com/");
  expect(browserURL("about:blank")).toBe("about:blank");
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "https://user:password@example.com",
    "javascript:alert(1)",
    "data:text/html,test",
    "",
  ])
    expect(() => browserURL(url)).toThrow();
});

test("browser boundaries reject oversized, malformed and non-finite input", () => {
  expect(browserInputSchema.safeParse({ kind: "text", text: "x".repeat(32001) }).success).toBe(
    false,
  );
  expect(browserInputSchema.safeParse({ kind: "resize", width: 0, height: 600 }).success).toBe(
    false,
  );
  expect(
    browserInputSchema.safeParse({ kind: "resize", width: 400, height: Infinity }).success,
  ).toBe(false);
  expect(browserInputSchema.safeParse({ kind: "take-control", actor: "agent" }).success).toBe(
    false,
  );
  expect(
    browserCommandSchema.safeParse({
      projectId: "unknown",
      threadId: "unknown",
      action: { kind: "open", url: "http://localhost" },
    }).success,
  ).toBe(false);
  const key = {
    kind: "key",
    action: "down",
    key: "ArrowLeft",
    code: "ArrowLeft",
    keyCode: 37,
    text: "",
    modifiers: 1,
  };
  expect(browserInputSchema.safeParse({ ...key, command: "moveWordLeft" }).success).toBe(true);
  expect(browserInputSchema.safeParse({ ...key, command: "insertHTML" }).success).toBe(false);
  expect(browserStateSchema.parse(emptyBrowserState).keyboardCommands).toBeUndefined();
});

test("only loopback development links use the project-host browser", () => {
  for (const url of [
    "http://localhost:3000",
    "http://app.localhost:5173",
    "http://127.0.0.1:8080",
    "http://[::1]:3000",
  ])
    expect(isDevelopmentURL(url)).toBe(true);
  for (const url of [
    "https://example.com",
    "https://localhost.example.com",
    "file:///tmp/page.html",
    "not a URL",
  ])
    expect(isDevelopmentURL(url)).toBe(false);
});
