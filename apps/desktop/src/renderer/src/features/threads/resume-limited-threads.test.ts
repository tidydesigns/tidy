import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { DesktopAPI, Project } from "../../../../shared/contracts/desktop";
import type {
  ThreadRecoveryRequest,
  ThreadRecoveryResult,
} from "../../../../shared/contracts/thread-recovery";
import { ResumeLimitedThreads } from "./resume-limited-threads";

test("one recovery click visits all projects without snapshots and fences duplicate clicks and machine changes", async () => {
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
  const project = (name: string): Project => ({
    id: crypto.randomUUID(),
    name,
    path: `/fixture/${name}`,
    openedAt: new Date().toISOString(),
  });
  const projects = [project("one"), project("two")];
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const requests: ThreadRecoveryRequest[] = [];
  const gates: Array<ReturnType<typeof Promise.withResolvers<ThreadRecoveryResult>>> = [];
  const reads: string[] = [];
  const api = {
    projectSnapshot: async (id: string) => {
      reads.push(id);
      throw new Error("Recovery must not load project snapshots");
    },
    resumeLimitedThreads: (request: ThreadRecoveryRequest) => {
      requests.push(request);
      const gate = Promise.withResolvers<ThreadRecoveryResult>();
      gates.push(gate);
      return gate.promise;
    },
  } as unknown as DesktopAPI;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (currentApi = api) =>
    root.render(
      createElement(ResumeLimitedThreads, {
        api: currentApi,
        projects,
      }),
    );
  try {
    await act(async () => render());
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Resume all limited threads");
    await act(async () => {
      button.click();
      button.click();
    });
    expect(button.disabled).toBe(true);
    expect(requests).toEqual([{ projectId: projects[0].id }]);
    await act(async () => {
      gates[0].resolve({ resumed: [first], skipped: [], failed: [] });
    });
    expect(reads).toEqual([]);
    expect(requests[1]).toEqual({ projectId: projects[1].id });
    await act(async () => {
      gates[1].resolve({ resumed: [second], skipped: [], failed: [] });
    });
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(requests).toHaveLength(3);
    await act(async () => render({ ...api }));
    await act(async () => button.click());
    expect(requests).toHaveLength(4);
    await act(async () => gates[2].resolve({ resumed: [first], skipped: [], failed: [] }));
    expect(requests).toHaveLength(4); // Changing machines cancels subsequent project submissions.
    expect(button.disabled).toBe(true); // An obsolete attempt cannot unlock the newer action.
    await act(async () => root.unmount());
    await act(async () => gates[3].resolve({ resumed: [], skipped: [], failed: [] }));
    expect(requests).toHaveLength(4);
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
