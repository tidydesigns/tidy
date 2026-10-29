import { expect, test } from "bun:test";
import { DesignRefresh } from "./design-refresh";

test("continuous file events cannot postpone the first refresh until writing stops", async () => {
  const observed = Promise.withResolvers<void>();
  let writing = true;
  const refresh = new DesignRefresh(async () => {
    expect(writing).toBe(true);
    observed.resolve();
  });
  const writes = setInterval(refresh.request, 2);
  const timeout = setTimeout(() => observed.reject(new Error("Refresh starved")), 1000);
  try {
    await observed.promise;
  } finally {
    writing = false;
    clearInterval(writes);
    clearTimeout(timeout);
    refresh.close();
  }
});

test("events during a scan coalesce into one trailing scan without overlap", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const trailing = Promise.withResolvers<void>();
  let calls = 0;
  const refresh = new DesignRefresh(async () => {
    calls++;
    if (calls === 1) {
      started.resolve();
      await release.promise;
    } else trailing.resolve();
  });
  try {
    refresh.request();
    await started.promise;
    for (let i = 0; i < 100; i++) refresh.request();
    await Bun.sleep(40);
    expect(calls).toBe(1);
    release.resolve();
    await trailing.promise;
    await Bun.sleep(40);
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    refresh.close();
  }
});

test("failed scans accept the next event and closing cancels pending refreshes", async () => {
  const started = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<void>();
  let calls = 0;
  const refresh = new DesignRefresh(async () => {
    if (++calls === 1) {
      started.resolve();
      throw new Error("Partial agent write");
    }
    recovered.resolve();
  });
  try {
    refresh.request();
    await started.promise;
    refresh.request();
    await recovered.promise;
    refresh.request();
    refresh.close();
    refresh.request();
    await Bun.sleep(40);
    expect(calls).toBe(2);
  } finally {
    refresh.close();
  }
});
