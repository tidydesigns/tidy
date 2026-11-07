import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { clearToasts, ToastViewport } from "@tidy/ui/toast";
import type {
  DesktopAPI,
  DesktopEvent,
  Project,
  ThreadSummary,
} from "../../../../shared/contracts/desktop";
import { HarnessFailureNotices } from "./harness-failure-dialog";

test("bulk recovery suppresses only covered failures; cloud-owned threads keep their Details toast", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const local: Project = {
    id: crypto.randomUUID(),
    name: "Local",
    path: "/fixture/local",
    openedAt: new Date().toISOString(),
  };
  const cloud = crypto.randomUUID();
  const listeners = new Set<(event: DesktopEvent) => void>();
  const api = {
    onEvent: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resumeLimitedThreads: async () => ({ resumed: [], skipped: [], failed: [] }),
  } as unknown as DesktopAPI;
  const thread: ThreadSummary = {
    id: crypto.randomUUID(),
    projectId: cloud,
    revision: 1,
    title: "Cloud thread",
    harness: "codex",
    designIds: [],
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  const emit = (thread: ThreadSummary) => {
    for (const listener of listeners) listener({ type: "thread-summary", thread });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      clearToasts();
      root.render(
        createElement(
          ToastViewport,
          null,
          createElement(HarnessFailureNotices, { api, projects: [local] }),
        ),
      );
    });
    await act(async () => {
      emit(thread);
      emit({ ...thread, revision: 2, status: "failed", errorKind: "usage-limit" });
      const covered = { ...thread, id: crypto.randomUUID(), projectId: local.id };
      emit(covered);
      emit({ ...covered, revision: 2, status: "failed", errorKind: "usage-limit" });
    });
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(1);
    expect(document.body.textContent).toContain("Usage limit reached: Cloud thread");
    expect(document.querySelector(".tidy-toast-action")?.textContent).toBe("Details");
    expect(document.querySelector("dialog[open]")).toBeNull();
    await act(async () => emit({ ...thread, revision: 3, status: "running" }));
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(0);
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
