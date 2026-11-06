import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { DesktopAPI, DesktopEvent, Project } from "../../../../shared/contracts/desktop";
import { useThreadCompletion } from "./use-thread-completion";
import { completionHealth, retryCompletionChecks } from "../settings/thread-completion-health";

test("completion registration exposes failures, retries, refreshes on focus, and ignores stale responses", async () => {
  const window = new Window({ url: "https://fixture.invalid" });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const calls: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const forced: boolean[] = [];
  let receive: ((event: DesktopEvent) => void) | undefined;
  const api = {
    autoCompleteThreads: (_projectId: string, _preferences: unknown, force = false) => {
      forced.push(force);
      const call = Promise.withResolvers<void>();
      calls.push(call);
      return call.promise;
    },
    onEvent: (listener: (event: DesktopEvent) => void) => {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
  } as unknown as DesktopAPI;
  const project: Project = {
    id: crypto.randomUUID(),
    name: "Fixture project",
    path: "/fixture",
    openedAt: new Date().toISOString(),
  };
  const root = createRoot(document.createElement("div"));
  function Probe() {
    useThreadCompletion(api, [project], true);
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(calls).toHaveLength(1);
    await act(async () => {
      calls[0].reject(new Error("Unavailable"));
      await Promise.resolve();
    });
    expect(completionHealth()).toEqual([project.name]);
    await act(async () => retryCompletionChecks());
    expect(calls).toHaveLength(2);
    expect(forced[1]).toBe(true);
    await act(async () => retryCompletionChecks());
    await act(async () => {
      calls[2].resolve();
      await Promise.resolve();
    });
    await act(async () => {
      calls[1].reject(new Error("Old failure"));
      await Promise.resolve();
    });
    expect(completionHealth()).toEqual([]);
    // Completion events are handled by the host; the renderer adds no event subscriber.
    expect(receive).toBeUndefined();
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    expect(calls).toHaveLength(4);
    expect(forced[3]).toBe(true);
    await act(async () => calls[3].resolve());
  } finally {
    await act(async () => root.unmount());
    expect(completionHealth()).toEqual([]);
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
