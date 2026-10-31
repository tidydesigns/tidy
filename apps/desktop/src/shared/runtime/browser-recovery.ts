import type { Bootstrap, DesktopEvent, ProjectSnapshot, Thread } from "../contracts/desktop";

export function browserRecovery({
  bootstrap,
  snapshot,
  readThread,
  listener,
  onError,
  trackedThreadsOnly = false,
}: {
  bootstrap(): Promise<Bootstrap>;
  snapshot(projectId: string): Promise<ProjectSnapshot>;
  readThread(projectId: string, threadId: string): Promise<Thread>;
  listener(event: DesktopEvent): void;
  onError(error: unknown): void;
  trackedThreadsOnly?: boolean;
}) {
  const projects = new Set<string>();
  const designVersions = new Map<string, number>();
  const threads = new Map<string, string>();
  const revisions = new Map<string, number>();
  let generation = 0;
  let closed = false;
  return {
    forget(projectId: string) {
      generation++;
      projects.delete(projectId);
      designVersions.delete(projectId);
      for (const [id, owner] of threads) {
        if (owner !== projectId) continue;
        threads.delete(id);
        revisions.delete(id);
      }
    },
    remember(value: ProjectSnapshot | null) {
      if (value) {
        projects.delete(value.project.id);
        projects.add(value.project.id);
      }
    },
    rememberThread(thread: Thread) {
      projects.delete(thread.projectId);
      projects.add(thread.projectId);
      threads.delete(thread.id);
      threads.set(thread.id, thread.projectId);
      if (threads.size > 32) threads.delete(threads.keys().next().value!);
      revisions.set(thread.id, Math.max(revisions.get(thread.id) ?? -1, thread.revision));
    },
    cancel() {
      generation++;
    },
    receive(event: DesktopEvent) {
      if (closed) return;
      if (event.type === "repository-change") {
        listener(event);
        return;
      }
      if (event.type === "designs")
        designVersions.set(event.projectId, (designVersions.get(event.projectId) ?? 0) + 1);
      if (event.type !== "designs") {
        const previous = revisions.get(event.thread.id) ?? -1;
        if (event.thread.revision < previous) return;
        revisions.set(event.thread.id, event.thread.revision);
      }
      listener(event);
    },
    refresh(bootstrapRequired = false) {
      const current = ++generation;
      const versions = new Map(designVersions);
      const stale = () => closed || current !== generation;
      const task = (async () => {
        try {
          if (bootstrapRequired || !projects.size) {
            const initial = await bootstrap();
            if (stale()) return;
            if (initial.activeProject) projects.add(initial.activeProject.project.id);
          }
          for (const projectId of trackedThreadsOnly ? [...projects].reverse() : [...projects]) {
            if (stale()) return;
            try {
              const project = await snapshot(projectId);
              if (stale()) return;
              if (versions.get(projectId) === designVersions.get(projectId))
                listener({
                  type: "designs",
                  projectId,
                  designs: project.designs,
                  folders: project.folders,
                });
              if (trackedThreadsOnly) {
                for (const summary of project.threads) {
                  if (stale()) return;
                  if ((revisions.get(summary.id) ?? -1) <= summary.revision) {
                    listener({ type: "thread-summary", thread: summary });
                  }
                }
              }
              const selected = trackedThreadsOnly
                ? [...threads]
                    .reverse()
                    .filter(([, projectId]) => projectId === project.project.id)
                    .map(([id]) => id)
                : project.threads.map((summary) => summary.id);
              let next = 0;
              await Promise.all(
                Array.from({ length: Math.min(4, selected.length) }, async () => {
                  while (next < selected.length && !stale()) {
                    const id = selected[next++];
                    try {
                      const thread = await readThread(projectId, id);
                      if (stale()) return;
                      if (thread.revision >= (revisions.get(id) ?? -1)) {
                        revisions.set(id, thread.revision);
                        listener({ type: "thread", thread });
                      }
                    } catch (error) {
                      if (!stale()) onError(error);
                    }
                  }
                }),
              );
            } catch (error) {
              if (!stale()) onError(error);
            }
          }
        } catch (error) {
          if (!stale()) {
            onError(error);
            if (bootstrapRequired) throw error;
          }
        }
      })();
      return task;
    },
    close() {
      closed = true;
      generation++;
    },
  };
}
