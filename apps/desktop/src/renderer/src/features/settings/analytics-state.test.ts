import { expect, test } from "bun:test";
import { ANALYTICS_NOTICE, type AnalyticsAPI, type AnalyticsState } from "@tidy/design/analytics";
import {
  cachedAnalyticsState,
  readAnalyticsState,
  subscribeAnalyticsState,
  unexpiredAnalyticsState,
} from "./analytics-state";

const off: AnalyticsState = {
  notice: ANALYTICS_NOTICE,
  available: true,
  usage: false,
  diagnostics: false,
  expiresAt: null,
  linked: false,
  pendingDeletion: false,
  reference: null,
};

test("expired cached consent drops both purposes and account linking without changing its source", () => {
  const expired = {
    ...off,
    usage: true,
    diagnostics: true,
    linked: true,
    expiresAt: new Date(0).toISOString(),
  };
  expect(unexpiredAnalyticsState(expired)).toEqual({
    ...expired,
    usage: false,
    diagnostics: false,
    linked: false,
    expiresAt: null,
  });
  expect(expired.usage).toBe(true);
  const valid = { ...expired, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  expect(unexpiredAnalyticsState(valid)).toBe(valid);
  expect(unexpiredAnalyticsState(off)).toBe(off);
  expect(unexpiredAnalyticsState(undefined)).toBeUndefined();
});

function fixture() {
  const listeners = new Set<(state: AnalyticsState) => void>();
  let reads = 0;
  let resolve!: (state: AnalyticsState) => void;
  let reject!: (error: Error) => void;
  const api: AnalyticsAPI = {
    state: () => {
      reads++;
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose: async () => off,
    link: async () => {},
    unlink: async () => off,
    erase: async () => off,
    reports: async () => "",
    policy: async () => {},
    reportError: async () => {},
    performance: async () => {},
  };
  return {
    api,
    reads: () => reads,
    resolve: (value: AnalyticsState) => resolve(value),
    reject: () => reject(new Error("Unavailable")),
    push: (value: AnalyticsState) => {
      for (const listener of listeners) listener(value);
    },
  };
}

test("settings and diagnostics share an in-flight read but refresh completed snapshots", async () => {
  const f = fixture();
  expect(cachedAnalyticsState(f.api)).toBeUndefined();
  const first = readAnalyticsState(f.api);
  expect(readAnalyticsState(f.api)).toBe(first);
  expect(f.reads()).toBe(1);
  f.resolve(off);
  expect(await first).toEqual(off);
  expect(cachedAnalyticsState(f.api)).toEqual(off);
  const refresh = readAnalyticsState(f.api);
  expect(f.reads()).toBe(2);
  f.resolve(off);
  await refresh;
  expect(cachedAnalyticsState(fixture().api)).toBeUndefined();
});

test("a delayed read cannot undo consent pushed by the native service", async () => {
  const f = fixture();
  const received: AnalyticsState[] = [];
  const unsubscribe = subscribeAnalyticsState(f.api, (value) => received.push(value));
  const read = readAnalyticsState(f.api);
  f.push(off);
  f.resolve({ ...off, usage: true, diagnostics: true });
  expect(await read).toEqual(off);
  expect(cachedAnalyticsState(f.api)).toEqual(off);
  unsubscribe();
  f.push({ ...off, usage: true });
  expect(received).toEqual([off]);
});

test("failed reads are retryable and never manufacture a consent snapshot", async () => {
  const f = fixture();
  const read = readAnalyticsState(f.api);
  f.reject();
  await expect(read).rejects.toThrow("Unavailable");
  expect(cachedAnalyticsState(f.api)).toBeUndefined();
  const retry = readAnalyticsState(f.api);
  expect(f.reads()).toBe(2);
  f.resolve(off);
  expect(await retry).toEqual(off);
});
