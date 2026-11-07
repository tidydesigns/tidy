import { expect, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { clearToasts, showToast, ToastViewport, useToastNotice } from "@tidy/ui/toast";

test("owned toasts update in place, replace actions, cancel obsolete expiry and clean up in Strict Mode", async () => {
  const window = new Window();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    setTimeout: ((callback: () => void, delay: number, ...args: unknown[]) => {
      if (delay !== 5000) return originalSetTimeout(callback, delay, ...args);
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.set(handle, () => {
        timers.delete(handle);
        callback();
      });
      return handle;
    }) as typeof setTimeout,
    clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
      if (!timers.delete(handle)) originalClearTimeout(handle);
    }) as typeof clearTimeout,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  type Notice = Parameters<typeof useToastNotice>[0];
  function Owned({ notice }: { notice: Notice }) {
    useToastNotice(notice);
    return null;
  }
  const render = (notice: Notice) =>
    act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Owned, { notice }),
          createElement(ToastViewport),
        ),
      ),
    );
  const clicks: string[] = [];
  try {
    clearToasts();
    await render({
      message: "One blocked thread",
      tone: "info",
      action: { label: "Resume", onClick: () => clicks.push("old") },
    });
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(1);
    const toast = document.querySelector(".tidy-toast");
    const action = document.querySelector<HTMLButtonElement>(".tidy-toast-action")!;
    action.focus();
    await act(async () => {
      showToast("Unrelated notification", "info");
    });
    await render({
      message: "Two blocked threads",
      tone: "info",
      action: { label: "Resume all", onClick: () => clicks.push("new") },
    });
    expect(document.querySelector(".tidy-toast")).toBe(toast);
    expect(document.querySelector(".tidy-toast-action")).toBe(action);
    expect(document.activeElement).toBe(action);
    expect(action.textContent).toBe("Resume all");
    await act(async () => action.click());
    expect(clicks).toEqual(["new"]);
    await render({ message: "Done", tone: "success" });
    expect(document.querySelector(".tidy-toast-action")).toBeNull();
    expect(timers.size).toBe(1);
    await render({ message: "A new failure", tone: "error" });
    expect(timers.size).toBe(0); // The old success timer must never dismiss this error.
    expect(document.querySelector(".tidy-toast")).toBe(toast);
    await render({ message: "Done again", tone: "success" });
    expect(timers.size).toBe(1);
    await act(async () => {
      [...timers.values()][0]();
    });
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(1);
    expect(document.body.textContent).toBe("iUnrelated notification×");
    await render({ message: "Visible again", tone: "info" });
    await render(null);
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(1);
    await render({ message: "Unmount me", tone: "info" });
    await act(async () => root.unmount());
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(0);
    expect(timers.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    clearToasts();
    window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
