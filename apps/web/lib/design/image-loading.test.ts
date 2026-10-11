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
test("shared in-flight requests abort only when their last consumer leaves", async () => {
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
    await Promise.resolve();
    a();
    expect(signal.aborted).toBe(false);
    b();
    expect(signal.aborted).toBe(true);
  } finally {
    a();
    b();
  }
});

test("a 60-image canvas drains without overflowing four server slots, including slow bodies", async () => {
  let active = 0,
    peak = 0,
    rejected = 0,
    calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (active >= 4) {
      rejected++;
      return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
    }
    peak = Math.max(peak, ++active);
    return new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            active--;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          }, 5);
        },
      }),
    );
  }) as unknown as typeof fetch;
  const blobs = await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      fetchImage(`/api/assets/burst-${index}`, new AbortController().signal),
    ),
  );
  expect(blobs.every((blob) => blob.size === 1)).toBe(true);
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(rejected).toBe(0);
  expect(calls).toBe(60);
});

test("canceling a queued image removes it without fetching or blocking the next image", async () => {
  const started: string[] = [];
  const complete: (() => void)[] = [];
  globalThis.fetch = (async (source: string) => {
    started.push(source);
    return new Response(
      new ReadableStream({
        start(controller) {
          complete.push(() => controller.close());
        },
      }),
    );
  }) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  const first = fetchImage("/api/assets/first", signal);
  const second = fetchImage("/api/assets/second", signal);
  const canceled = new AbortController();
  const third = fetchImage("/api/assets/canceled", canceled.signal);
  const fourth = fetchImage("/api/assets/fourth", signal);
  canceled.abort(new Error("left canvas"));
  await expect(third).rejects.toThrow("left canvas");
  expect(started).toEqual(["/api/assets/first", "/api/assets/second"]);
  complete.shift()!();
  await first;
  expect(started).toEqual(["/api/assets/first", "/api/assets/second", "/api/assets/fourth"]);
  for (const finish of complete) finish();
  await Promise.all([second, fourth]);
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  await expect(fetchImage("/api/assets/never", alreadyCanceled.signal)).rejects.toThrow();
  expect(started).toHaveLength(3);
});

test("retry backoff releases its slot so other images can load", async () => {
  const canceled = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (source: string) => {
    calls++;
    return new Response(null, { status: source.endsWith("retry") ? 503 : 200 });
  }) as unknown as typeof fetch;
  const retrying = [
    fetchImage("/api/assets/first-retry", canceled.signal),
    fetchImage("/api/assets/second-retry", canceled.signal),
  ];
  const settled = Promise.allSettled(retrying);
  try {
    // The retries have a minimum 500 ms delay. The third image must not wait for it.
    await fetchImage("/api/assets/ready", AbortSignal.timeout(250));
    expect(calls).toBe(3);
  } finally {
    canceled.abort();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
  }
});
