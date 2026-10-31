import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type { ThreadTask, ThreadTasks } from "../../../../shared/contracts/thread-tasks";

export function mergeThreadTasks(previous: ThreadTask[], incoming: ThreadTask[]) {
  const tasks = new Map(previous.map((task) => [task.id, task]));
  for (const task of incoming) {
    const existing = tasks.get(task.id);
    if (!existing || task.sequence >= existing.sequence) tasks.set(task.id, task);
  }
  return [...tasks.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function useThreadTasks({
  api,
  projectId,
  threadId,
  active,
  connected,
}: {
  api: DesktopAPI;
  projectId?: string;
  threadId?: string;
  active: boolean;
  connected?: boolean;
}) {
  const [value, setValue] = useState<ThreadTasks>({ parent: null, tasks: [], nextCursor: null });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = useRef<() => void>(() => {});
  const more = useRef<() => void>(() => {});
  const cursor = useRef<number | null>(null);
  const cache = useRef<{
    api: DesktopAPI;
    projectId: string;
    threadId: string;
    value: ThreadTasks;
  } | null>(null);
  useEffect(() => {
    if (!active || connected === false || !projectId || !threadId || !api.readThreadTasks) return;
    let mounted = true;
    let running = false;
    let dirty = false;
    let sequence = -1;
    const retained =
      cache.current?.api === api &&
      cache.current.projectId === projectId &&
      cache.current.threadId === threadId
        ? cache.current.value
        : undefined;
    let initialized = retained !== undefined;
    let loaded: ThreadTask[] = retained?.tasks ?? [];
    cursor.current = retained?.nextCursor ?? null;
    const read = api.readThreadTasks;
    const refresh = async (before?: number) => {
      if (running) {
        if (before === undefined) dirty = true;
        return;
      }
      running = true;
      setLoading(true);
      try {
        do {
          dirty = false;
          const page = await read({ projectId, threadId, ...(before ? { before } : {}) });
          if (!mounted) return;
          let incoming = page.tasks;
          if (before === undefined && initialized) {
            const recent = new Set(page.tasks.map((task) => task.id));
            const older = loaded.filter(
              (task) =>
                ["queued", "running", "cancel_requested"].includes(task.state) &&
                !recent.has(task.id),
            );
            for (let offset = 0; offset < older.length; offset += 8) {
              const updates = await read({
                projectId,
                threadId,
                taskIds: older.slice(offset, offset + 8).map((task) => task.id),
              });
              if (!mounted) return;
              incoming = [...incoming, ...updates.tasks];
            }
          }
          setError("");
          const overlap = new Set(loaded.map((task) => task.id));
          const historyGap =
            page.nextCursor !== null && !page.tasks.some((task) => overlap.has(task.id));
          const nextCursor =
            before !== undefined || !initialized || historyGap ? page.nextCursor : cursor.current;
          const replace = !initialized;
          loaded = mergeThreadTasks(replace ? [] : loaded, incoming);
          const nextValue = { ...page, tasks: loaded, nextCursor };
          cache.current = { api, projectId, threadId, value: nextValue };
          setValue(nextValue);
          cursor.current = nextCursor;
          initialized = true;
          before = undefined;
        } while (dirty && mounted);
      } catch {
        if (mounted) setError("Could not refresh agent status.");
      } finally {
        running = false;
        if (mounted) setLoading(false);
      }
    };
    const update = () => {
      void refresh();
    };
    reload.current = update;
    more.current = () => {
      if (cursor.current !== null) void refresh(cursor.current);
    };
    const unsubscribe = api.onEvent((event) => {
      if (
        event.type !== "thread-summary" ||
        event.thread.projectId !== projectId ||
        event.thread.id !== threadId
      )
        return;
      const next = event.thread.taskSequence;
      if (next === undefined || next <= sequence) return;
      sequence = next;
      update();
    });
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    update();
    return () => {
      mounted = false;
      reload.current = () => {};
      more.current = () => {};
      unsubscribe();
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
    };
  }, [api, projectId, threadId, active, connected]);
  return {
    ...value,
    error,
    loading,
    retry: () => reload.current(),
    loadMore: () => more.current(),
  };
}
