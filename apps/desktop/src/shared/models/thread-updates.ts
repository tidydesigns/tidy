import type { Thread, ThreadSummary, ProjectSnapshot, DesktopEvent } from "../contracts/desktop";
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
    titleSource: thread.titleSource,
    titleRevision: thread.titleRevision,
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
    errorKind: thread.errorKind,
    updatedAt: thread.updatedAt,
  };
}
export function applyThreadPatch(previous: Thread, patch: ThreadPatch): Thread {
  if (
    previous.id !== patch.thread.id ||
    previous.projectId !== patch.thread.projectId ||
    previous.revision >= patch.thread.revision
  )
    return previous;
  function merge<T extends { id: string }>(existing: T[], changed: T[]) {
    if (!changed.length) return existing;
    if (changed.length === 1) {
      const update = changed[0];
      const index = existing.findIndex((item) => item.id === update.id);
      if (index === -1) return [...existing, update];
      const next = existing.slice();
      next[index] = update;
      return next;
    }
    const updates = new Map<string, T>();
    for (const item of changed) updates.set(item.id, item);
    const next = existing.map((item) => {
      const value = updates.get(item.id);
      updates.delete(item.id);
      return value ?? item;
    });
    for (const item of updates.values()) next.push(item);
    return next;
  }
  const tools = merge(previous.toolActivities ?? [], patch.toolActivities);
  let nextTools = tools;
  if (
    tools.length !== patch.toolActivityIds.length ||
    tools.some((tool, index) => tool.id !== patch.toolActivityIds[index])
  ) {
    const retained = new Set(patch.toolActivityIds);
    nextTools = tools.filter((tool) => retained.has(tool.id));
  }
  return {
    ...previous,
    ...patch.thread,
    error: patch.thread.error,
    errorKind: patch.thread.errorKind,
    messages: merge(previous.messages, patch.messages),
    toolActivities: nextTools,
  };
}

export function applyProjectEvent(snapshot: ProjectSnapshot, event: DesktopEvent): ProjectSnapshot {
  const projectId = event.type === "designs" ? event.projectId : event.thread.projectId;
  if (projectId !== snapshot.project.id) return snapshot;
  if (event.type === "designs")
    return { ...snapshot, designs: event.designs, folders: event.folders };
  const summary =
    event.type === "thread-patch"
      ? event.summary
      : event.type === "thread-summary"
        ? event.thread
        : summarizeThread(event.thread);
  const previous = snapshot.threads.find((item) => item.id === summary.id);
  if (previous && previous.revision > summary.revision) return snapshot;
  return {
    ...snapshot,
    threads: previous
      ? snapshot.threads.map((item) => (item.id === summary.id ? summary : item))
      : [summary, ...snapshot.threads],
  };
}
