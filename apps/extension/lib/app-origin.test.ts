import { describe, expect, test } from "bun:test";
import { appOrigin } from "./app-origin";

describe("extension app origin", () => {
  test("requires an explicit HTTPS origin for release builds", () => {
    expect(() => appOrigin(undefined, true)).toThrow("explicit HTTPS");
    expect(() => appOrigin("http://localhost:3000", true)).toThrow("explicit HTTPS");
    expect(appOrigin("https://app.example.com/", true)).toBe("https://app.example.com");
    expect(appOrigin()).toBe("http://localhost:3000");
  });
  test("rejects embedded credentials, insecure hosts and non-origin URLs", () => {
    for (const url of [
      "https://user:password@app.example.com",
      "http://app.example.com",
      "https://app.example.com/path",
      "https://app.example.com/?token=secret",
      "https://app.example.com/#secret",
      "file:///tmp/app",
    ])
      expect(() => appOrigin(url)).toThrow();
  });
});
