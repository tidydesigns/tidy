import { afterEach, expect, test, spyOn } from "bun:test";
import {
  fetchImage,
  retryDelay,
  subscribeImage,
  type ImageLoad,
} from "@tidy/design-renderer/image-loading";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function responses(...values: (number | Error)[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const value = values.shift() ?? 503;
    if (value instanceof Error) throw value;
    return new Response(null, { status: value });
  }) as unknown as typeof fetch;
  return () => calls;
}
test("network recovery is shared and object URLs survive until the last consumer leaves", async () => {
  const calls = responses(new TypeError("Network failure"), 200);
  const revoke = spyOn(URL, "revokeObjectURL");
  let first: ImageLoad | undefined, second: ImageLoad | undefined;
  let ready!: () => void;
  const loaded = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const a = subscribeImage("/api/assets/shared", (state) => {
    first = state;
  });
  const b = subscribeImage("/api/assets/shared", (state) => {
    if (state.status === "ready") {
      second = state;
      ready();
    }
  });
  try {
    await loaded;
    expect(second).toEqual(first);
    expect(calls()).toBe(2);
    a();
    expect(revoke).not.toHaveBeenCalled();
    b();
    expect(revoke).toHaveBeenCalledTimes(1);
  } finally {
    a();
    b();
    revoke.mockRestore();
  }
});
test("401, 403 and 404 stop immediately", async () => {
  for (const status of [401, 403, 404]) {
    const calls = responses(status);
    await expect(fetchImage("/api/assets/missing", new AbortController().signal)).rejects.toThrow(
      String(status),
    );
    expect(calls()).toBe(1);
  }
});
test("Retry-After handles seconds and dates and never retries before a long cooldown", async () => {
  expect(retryDelay("2", 0)).toBe(2000);
  expect(retryDelay("Thu, 08 Oct 2026 12:00:03 GMT", 0, Date.parse("2026-10-08T12:00:00Z"))).toBe(
    3000,
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  }) as unknown as typeof fetch;
  await expect(fetchImage("/api/assets/cooldown", new AbortController().signal)).rejects.toThrow(
    "429",
  );
  expect(calls).toBe(1);
});
test("shared in-flight requests abort only when their last consumer leaves", () => {
  let signal!: AbortSignal;
  globalThis.fetch = (async (_source: Parameters<typeof fetch>[0], init?: RequestInit) => {
    signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  }) as unknown as typeof fetch;
  const a = subscribeImage("/api/assets/in-flight", () => {});
  const b = subscribeImage("/api/assets/in-flight", () => {});
  try {
    a();
    expect(signal.aborted).toBe(false);
    b();
    expect(signal.aborted).toBe(true);
  } finally {
    a();
    b();
  }
});
