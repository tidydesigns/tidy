import { expect, spyOn, test } from "bun:test";
import { observeOperation } from "./operation-observability";

test("operation diagnostics identify a stalled dependency and preserve its eventual result", async () => {
  const logs: string[] = [];
  const info = spyOn(console, "info").mockImplementation((message) => {
    logs.push(String(message));
  });
  const warn = spyOn(console, "warn").mockImplementation((message) => {
    logs.push(String(message));
  });
  let release!: (value: object) => void;
  const result = { privateData: "never log result data" };
  try {
    const pending = observeOperation(
      new Headers({ "cf-ray": "test-ray", cookie: "secret-cookie" }),
      "asset.query",
      () =>
        new Promise<object>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5020));
    expect(logs.map((log) => JSON.parse(log).event)).toEqual([
      "operation_started",
      "operation_stalled",
    ]);
    expect(JSON.parse(logs[1])).toMatchObject({ ray: "test-ray", operation: "asset.query" });
    release(result);
    expect(await pending).toBe(result);
    expect(JSON.parse(logs.at(-1)!).event).toBe("operation_completed");
    expect(logs.join("\n")).not.toMatch(/privateData|secret-cookie|never log/);
  } finally {
    release(result);
    info.mockRestore();
    warn.mockRestore();
  }
}, 10_000);

test("operation failures retain the original error without logging sensitive messages", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  const records: string[] = [];
  const error = spyOn(console, "error").mockImplementation((message) => {
    records.push(String(message));
  });
  const failure = new Error("private query parameters");
  try {
    await expect(
      observeOperation(new Headers(), "files.session", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(JSON.parse(records[0]).event).toBe("operation_failed");
    expect(records.join("\n")).not.toContain("private");
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
});
