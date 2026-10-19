import {
  summarizeThread,
  type Thread,
  type ThreadSummary,
  type Message,
  type ProjectSnapshot,
  type DesktopEvent,
} from "./contracts";
import type { ToolActivity } from "./tool-activity";

export type ThreadPatch = {
  thread: Omit<Thread, "messages" | "toolActivities">;
  summary: ThreadSummary;
  messages: Message[];
  toolActivities: ToolActivity[];
  toolActivityIds: string[];
};

/** Preserve unchanged message/row identities as well as avoiding history copies over IPC. */
export function applyThreadPatch(previous: Thread, patch: ThreadPatch): Thread {
  if (
    previous.id !== patch.thread.id ||
    previous.projectId !== patch.thread.projectId ||
    previous.revision >= patch.thread.revision
  )
    return previous;
  function merge<T extends { id: string }>(existing: T[], changed: T[]) {
    if (!changed.length) return existing;
    const updates = new Map(changed.map((item) => [item.id, item]));
    const next = existing.map((item) => {
      const value = updates.get(item.id);
      updates.delete(item.id);
      return value ?? item;
    });
    return [...next, ...updates.values()];
  }
  const tools = merge(previous.toolActivities ?? [], patch.toolActivities);
  const retained = new Set(patch.toolActivityIds);
  const nextTools =
    tools.length === patch.toolActivityIds.length &&
    tools.every((tool, index) => tool.id === patch.toolActivityIds[index])
      ? tools
      : tools.filter((tool) => retained.has(tool.id));
  return {
    ...previous,
    ...patch.thread,
    messages: merge(previous.messages, patch.messages),
    toolActivities: nextTools,
  };
}

export function applyProjectEvent(snapshot: ProjectSnapshot, event: DesktopEvent): ProjectSnapshot {
  const projectId = event.type === "designs" ? event.projectId : event.thread.projectId;
  if (projectId !== snapshot.project.id) return snapshot;
  if (event.type === "designs")
    return { ...snapshot, designs: event.designs, folders: event.folders };
  const summary = event.type === "thread-patch" ? event.summary : summarizeThread(event.thread);
  const previous = snapshot.threads.find((item) => item.id === summary.id);
  if (previous && previous.revision > summary.revision) return snapshot;
  return {
    ...snapshot,
    threads: previous
      ? snapshot.threads.map((item) => (item.id === summary.id ? summary : item))
      : [summary, ...snapshot.threads],
  };
}
