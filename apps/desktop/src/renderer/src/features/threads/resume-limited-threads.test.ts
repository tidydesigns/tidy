import { expect, test } from "bun:test";
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { clearToasts, ToastViewport } from "@tidy/ui/toast";
import type {
  DesktopAPI,
  DesktopEvent,
  Project,
  ProjectSnapshot,
  ThreadSummary,
} from "../../../../shared/contracts/desktop";
import type {
  ThreadRecoveryRequest,
  ThreadRecoveryResult,
} from "../../../../shared/contracts/thread-recovery";
import { ResumeLimitedThreads } from "./resume-limited-threads";

test("limited threads share a dismissible recovery toast; one click resumes across projects and fences machine changes", async () => {
  const window = new Window({ url: "https://fixture.invalid" });
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
  const projects: Project[] = ["one", "two"].map((name) => ({
    id: crypto.randomUUID(),
    name,
    path: `/fixture/${name}`,
    openedAt: new Date().toISOString(),
  }));
  const listeners = new Set<(event: DesktopEvent) => void>();
  const requests: ThreadRecoveryRequest[] = [];
  const gates: Array<ReturnType<typeof Promise.withResolvers<ThreadRecoveryResult>>> = [];
  const api = {
    onEvent(listener: (event: DesktopEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    projectSnapshot: async () => {
      throw new Error("Recovery must not load project snapshots");
    },
    resumeLimitedThreads: (request: ThreadRecoveryRequest) => {
      requests.push(request);
      const gate = Promise.withResolvers<ThreadRecoveryResult>();
      gates.push(gate);
      return gate.promise;
    },
  } as unknown as DesktopAPI;
  const threads: ThreadSummary[] = Array.from({ length: 9 }, (_, index) => ({
    id: crypto.randomUUID(),
    projectId: projects[index % 2].id,
    title: `Thread ${index}`,
    harness: "codex",
    status: "failed",
    designIds: [],
    errorKind: "usage-limit",
    error: "Usage limit reached",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const emit = (thread: ThreadSummary) => {
    for (const listener of listeners) listener({ type: "thread-summary", thread });
  };
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  let commits = 0;
  const render = (currentApi = api, snapshots?: Record<string, ProjectSnapshot>) =>
    root.render(
      createElement(
        ToastViewport,
        null,
        createElement(
          Profiler,
          {
            id: "recovery",
            onRender: () => {
              commits++;
            },
          },
          createElement(ResumeLimitedThreads, { api: currentApi, projects, snapshots }),
        ),
      ),
    );
  const action = () => document.querySelector<HTMLButtonElement>(".tidy-toast-action");
  const dismiss = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
  try {
    await act(async () => {
      clearToasts();
      render();
    });
    expect(container.textContent).toBe("");
    expect(action()).toBeNull();
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(0);
    await act(async () => {
      emit({ ...threads[0], status: "running", revision: 0, error: undefined });
      for (const thread of threads) {
        emit(thread);
        emit(thread);
      }
      emit({ ...threads[0], revision: 0, status: "running" }); // stale update
      emit({ ...threads[0], id: crypto.randomUUID(), parentThreadId: threads[0].id });
      emit({ ...threads[0], id: crypto.randomUUID(), doneAt: new Date().toISOString() });
    });
    expect(document.querySelectorAll(".tidy-toast")).toHaveLength(1);
    expect(document.body.textContent).toContain("9 threads are blocked");
    expect(requests).toHaveLength(0);

    const firstAction = action()!;
    firstAction.focus();
    const additional = { ...threads[0], id: crypto.randomUUID() };
    await act(async () => emit(additional));
    expect(document.body.textContent).toContain("10 threads are blocked");
    expect(action()).toBe(firstAction);
    expect(document.activeElement).toBe(firstAction);
    const before = commits;
    const streaming = { ...additional, id: crypto.randomUUID(), status: "running" as const };
    for (let revision = 2; revision <= 101; revision++)
      await act(async () => {
        emit({ ...additional, revision }); // failed-thread metadata
        emit({ ...streaming, revision }); // another agent's streaming output
      });
    expect(commits - before).toBe(0);
    expect(action()).toBe(firstAction);
    await act(async () =>
      emit({ ...additional, revision: 102, status: "running", error: undefined }),
    );
    expect(document.body.textContent).toContain("9 threads are blocked");
    expect(action()).toBe(firstAction);
    expect(document.activeElement).toBe(firstAction);
    await act(async () => dismiss().click());
    await act(async () => emit({ ...threads[0], revision: 2 }));
    expect(action()).toBeNull(); // metadata must not reopen a dismissed failure
    await act(async () =>
      emit({ ...threads[0], revision: 3, status: "running", error: undefined }),
    );
    await act(async () => emit({ ...threads[0], revision: 4 }));
    expect(action()?.textContent).toBe("Resume all");
    const retryAction = action();
    await act(async () => {
      action()!.click();
      action()!.click();
    });
    expect(action()?.disabled).toBe(true);
    expect(action()?.textContent).toBe("Resuming…");
    expect(action()).toBe(retryAction);
    expect(requests).toEqual([{ projectId: projects[0].id }]);
    await act(async () =>
      gates[0].resolve({
        resumed: threads
          .filter((thread) => thread.projectId === projects[0].id)
          .map((thread) => thread.id),
        skipped: [],
        failed: [],
      }),
    );
    expect(requests[1]).toEqual({ projectId: projects[1].id });
    await act(async () =>
      gates[1].resolve({
        resumed: threads
          .filter((thread) => thread.projectId === projects[1].id)
          .map((thread) => thread.id),
        skipped: [],
        failed: [],
      }),
    );
    expect(action()).toBeNull();
    expect(document.body.textContent).toContain("Resumed 9 threads.");
    await act(async () => {
      clearToasts();
      emit({ ...threads[0], revision: 5 });
    });
    await act(async () => action()!.click());
    const nextApi = { ...api };
    await act(async () => render(nextApi));
    expect(action()).toBeNull();
    await act(async () => emit({ ...threads[0], revision: 6 }));
    await act(async () => action()!.click());
    expect(requests).toHaveLength(4);
    await act(async () => gates[2].resolve({ resumed: [threads[0].id], skipped: [], failed: [] }));
    expect(requests).toHaveLength(4);
    expect(action()?.disabled).toBe(true);
    await act(async () => root.unmount());
    await act(async () => gates[3].resolve({ resumed: [], skipped: [], failed: [] }));
    expect(requests).toHaveLength(4);
    expect(listeners.size).toBe(0);
    expect(action()).toBeNull();

    // Previously limited threads are discovered from loaded summaries after relaunch.
    root = createRoot(container);
    const restored = { ...threads[0], revision: 7 };
    const snapshots = {
      [projects[0].id]: { project: projects[0], threads: [restored], designs: [], folders: [] },
    };
    await act(async () => render(api, snapshots));
    expect(document.body.textContent).toContain("1 thread is blocked");
    expect(requests).toHaveLength(4); // Observing limits never submits work.
    await act(async () => action()!.click());
    await act(async () => {
      emit({ ...restored, revision: 8, status: "running", error: undefined });
      emit({ ...restored, revision: 9 });
      gates[4].resolve({ resumed: [restored.id], skipped: [], failed: [] });
    });
    await act(async () => gates[5].resolve({ resumed: [], skipped: [], failed: [] }));
    expect(action()?.disabled).toBe(false); // A newer failure survives an older resume response.
    await act(async () => action()!.click());
    await act(async () =>
      gates[6].resolve({
        resumed: [],
        skipped: [],
        failed: [{ threadId: restored.id, error: "Allowance still unavailable" }],
      }),
    );
    await act(async () => gates[7].resolve({ resumed: [], skipped: [], failed: [] }));
    expect(document.body.textContent).toContain("Allowance still unavailable");
    expect(action()?.disabled).toBe(false); // Partial failures remain actionable.
    await act(async () =>
      emit({ ...restored, revision: 10, status: "completed", error: undefined }),
    );
    expect(action()).toBeNull();
    await act(async () => root.unmount());
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
