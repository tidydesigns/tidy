import { afterEach, expect, test } from "bun:test";
import { HostBridge } from "./bridge";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("host boundaries preserve metadata, reject malformed payloads, and settle pending requests", async () => {
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  const sent: { id?: number | string; method?: string }[] = [];
  // This fixture implements only the Window surface consumed by the transport.
  const host = {
    postMessage: (message: { id?: number | string; method?: string }) => sent.push(message),
  };
  const hostWindow = host as unknown as Window;
  const bridge = new HostBridge(hostWindow);
  const receive = (data: unknown, origin = "https://host.example", source = hostWindow) =>
    events.dispatchEvent(
      Object.defineProperty(new MessageEvent("message", { data, origin }), "source", {
        value: source,
      }),
    );
  const results: unknown[] = [],
    errors: string[] = [];
  bridge.onResult = (result) => results.push(result);
  bridge.onError = (error) => errors.push(error.message);
  const connected = bridge.connect();
  receive({
    jsonrpc: "2.0",
    id: sent[0].id,
    result: { hostContext: { theme: "dark" }, extension: true },
  });
  await connected;
  receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: null });
  receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: null });
  expect(errors).toHaveLength(1);
  const result = {
    content: [{ type: "image", data: "bytes" }],
    _meta: { tidyPreview: { revision: 2 } },
  };
  receive(
    { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result },
    "https://other.example",
  );
  expect(results).toHaveLength(0);
  receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
  expect(results).toEqual([result]);
  const tool = bridge.callTool("preview_design", {});
  await Promise.resolve();
  receive({ jsonrpc: "2.0", id: sent.at(-1)?.id, result: null });
  await expect(tool).rejects.toThrow("could not be read");
  const pending = bridge.openLink("https://example.com");
  await Promise.resolve();
  receive({ jsonrpc: "2.0", id: "teardown", method: "ui/resource-teardown" });
  await expect(pending).rejects.toThrow("Preview closed");
  expect(sent.at(-1)?.id).toBe("teardown");
});
