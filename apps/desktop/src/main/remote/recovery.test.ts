import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { browserRecovery } from "../../shared/runtime/browser-recovery";
import { summarizeThread } from "../../shared/models/thread-updates";
import type { DesktopEvent, ProjectSnapshot, Thread } from "../../shared/contracts/desktop";
function fixture() {
  const project = {
    id: randomUUID(),
    path: "/fixture",
    name: "fixture",
    openedAt: new Date().toISOString(),
  };
  const threads: Thread[] = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    projectId: project.id,
    revision: 1,
    title: "thread",
    harness: "codex",
    status: "completed",
    designIds: [],
    messages: [],
    updatedAt: new Date().toISOString(),
  }));
  const snapshot: ProjectSnapshot = {
    project,
    threads: threads.map(summarizeThread),
    designs: [],
    folders: [],
  };
  return { threads, snapshot };
}
test("recovery refreshes summaries and only the bounded observed histories with bounded concurrency", async () => {
  const { threads, snapshot } = fixture();
  const events: DesktopEvent[] = [],
    reads: string[] = [];
  let active = 0,
    maximum = 0;
  const recovery = browserRecovery({
    trackedThreadsOnly: true,
    bootstrap: async () => ({
      projects: [snapshot.project],
      activeProject: snapshot,
      harnesses: [],
    }),
    snapshot: async () => snapshot,
    readThread: async (_projectId, id) => {
      reads.push(id);
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return threads.find((thread) => thread.id === id)!;
    },
    listener: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  for (const thread of threads) recovery.rememberThread(thread);
  await recovery.refresh();
  expect(reads).toHaveLength(32);
  expect(reads[0]).toBe(threads.at(-1)!.id);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(events.filter((event) => event.type === "thread-summary")).toHaveLength(100);
  recovery.close();
});
test("cancelled recovery cannot emit stale snapshots after the connection generation changes", async () => {
  const { threads, snapshot } = fixture();
  const events: DesktopEvent[] = [];
  let release: (snapshot: ProjectSnapshot) => void = () => {};
  const wait = new Promise<ProjectSnapshot>((resolve) => {
    release = resolve;
  });
  const recovery = browserRecovery({
    trackedThreadsOnly: true,
    bootstrap: async () => ({
      projects: [snapshot.project],
      activeProject: snapshot,
      harnesses: [],
    }),
    snapshot: () => wait,
    readThread: async () => threads[0],
    listener: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  recovery.rememberThread(threads[0]);
  const refreshing = recovery.refresh();
  recovery.cancel();
  release(snapshot);
  await refreshing;
  expect(events).toHaveLength(0);
});
