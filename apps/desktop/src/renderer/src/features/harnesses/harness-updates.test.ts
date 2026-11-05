import { expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { HarnessUpdateNotices, harnessUpdateSnoozed } from "./harness-updates";
import type { HarnessUpdateState } from "../../../../shared/contracts/harness-updates";

const entry: HarnessUpdateState = {
  id: "codex",
  status: "available",
  installedVersion: "1.2.3",
  latestVersion: "1.3.0",
  canInstall: true,
};
const day = 24 * 60 * 60_000;
const now = 1_000_000;
const snooze = JSON.stringify({ key: "1.2.3:1.3.0:available", until: now + day });

test("snoozes survive reload for one day and then expire", () => {
  expect(harnessUpdateSnoozed(entry, snooze, now)).toBe(true);
  expect(harnessUpdateSnoozed(entry, snooze, now + day - 1)).toBe(true);
  expect(harnessUpdateSnoozed(entry, snooze, now + day)).toBe(false);
});

test("a different release, installed version or outcome is not hidden by an old snooze", () => {
  expect(harnessUpdateSnoozed({ ...entry, latestVersion: "1.4.0" }, snooze, now)).toBe(false);
  expect(harnessUpdateSnoozed({ ...entry, installedVersion: "1.2.4" }, snooze, now)).toBe(false);
  expect(harnessUpdateSnoozed({ ...entry, status: "error" }, snooze, now)).toBe(false);
});

test("old permanent, corrupt or unbounded dismissals cannot hide releases", () => {
  for (const stored of [
    null,
    "1.3.0",
    "{",
    "null",
    '"string"',
    "false",
    JSON.stringify({ key: "1.2.3:1.3.0:available" }),
    JSON.stringify({ key: "1.2.3:1.3.0:available", until: now + day + 1 }),
  ])
    expect(harnessUpdateSnoozed(entry, stored, now)).toBe(false);
});

test("persisted notices stay snoozed after remount and reappear autonomously on expiry", async () => {
  const window = new Window({ url: "https://fixture.invalid" });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let current = now;
  const clock = spyOn(Date, "now").mockImplementation(() => current);
  const timers = new Map<number, () => void>();
  let serial = 0;
  window.setTimeout = ((callback: () => void) => {
    const id = ++serial;
    timers.set(id, callback);
    return id;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof window.clearTimeout;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let receive: ((entries: HarnessUpdateState[]) => void) | undefined;
  const api = {
    async harnessUpdates() {
      return [entry];
    },
    onHarnessUpdates(listener: (entries: HarnessUpdateState[]) => void) {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
    async installHarnessUpdate() {},
  };
  const render = () =>
    act(async () => {
      root.render(createElement(HarnessUpdateNotices, { api }));
    });
  try {
    localStorage.setItem("tidy:harness-update-snoozed:codex", snooze);
    await render();
    expect(host.querySelector(".harness-update-notice")).toBeNull();
    await act(async () => root.render(null));
    await render();
    expect(host.querySelector(".harness-update-notice")).toBeNull();
    expect(timers.size).toBe(1);
    current += day;
    await act(async () => {
      for (const callback of [...timers.values()]) callback();
      timers.clear();
    });
    expect(host.querySelector(".harness-update-notice")).not.toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".harness-update-dismiss")!.click(),
    );
    expect(host.querySelector(".harness-update-notice")).toBeNull();
    expect(JSON.parse(localStorage.getItem("tidy:harness-update-snoozed:codex")!).until).toBe(
      current + day,
    );
    await act(async () => receive?.([{ ...entry, latestVersion: "1.4.0" }]));
    expect(host.querySelector(".harness-update-notice")).not.toBeNull();
    await act(async () =>
      receive?.([{ ...entry, status: "current", checkError: "The backend is offline" }]),
    );
    expect(host.textContent).toContain("The backend is offline");
  } finally {
    await act(async () => root.unmount());
    clock.mockRestore();
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
