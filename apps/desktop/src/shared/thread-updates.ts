import type { Thread, ThreadSummary, ProjectSnapshot, DesktopEvent } from "./contracts";
export type ThreadPatch = Omit<Extract<DesktopEvent, { type: "thread-patch" }>, "type">;

export function summarizeThread(thread: Thread): ThreadSummary {
  let preview: string | undefined;
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index];
    if (message.role === "assistant") {
      preview = message.text.slice(0, 320);
      break;
    }
  }
  return {
    revision: thread.revision,
    id: thread.id,
    projectId: thread.projectId,
    executionProjectId: thread.executionProjectId,
    title: thread.title,
    harness: thread.harness,
    doneAt: thread.doneAt,
    settings: thread.settings,
    actualModel: thread.actualModel,
    usage: thread.usage,
    preview,
    messageCount: thread.messages.length,
    queuedMessageCount: thread.queuedMessages?.length ?? 0,
    designIds: thread.designIds,
    status: thread.status,
    activity: thread.activity,
    pendingApprovalCount: thread.pendingApprovals?.length,
    error: thread.error,
    updatedAt: thread.updatedAt,
  };
}
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
