import type { Bootstrap, DesktopEvent, ProjectSnapshot, Thread } from "./contracts";

export function browserRecovery({
  bootstrap,
  snapshot,
  readThread,
  listener,
  onError,
}: {
  bootstrap(): Promise<Bootstrap>;
  snapshot(projectId: string): Promise<ProjectSnapshot>;
  readThread(projectId: string, threadId: string): Promise<Thread>;
  listener(event: DesktopEvent): void;
  onError(error: unknown): void;
}) {
  const projects = new Set<string>();
  const designVersions = new Map<string, number>();
  let generation = 0;
  let closed = false;
  return {
    remember(value: ProjectSnapshot | null) {
      if (value) projects.add(value.project.id);
    },
    receive(event: DesktopEvent) {
      if (closed) return;
      if (event.type === "designs")
        designVersions.set(event.projectId, (designVersions.get(event.projectId) ?? 0) + 1);
      listener(event);
    },
    async refresh() {
      const current = ++generation;
      const versions = new Map(designVersions);
      const stale = () => closed || current !== generation;
      try {
        if (!projects.size) {
          const initial = await bootstrap();
          if (stale()) return;
          if (initial.activeProject) projects.add(initial.activeProject.project.id);
        }
        for (const projectId of projects) {
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
            for (const summary of project.threads) {
              if (stale()) return;
              const thread = await readThread(projectId, summary.id);
              if (stale()) return;
              listener({ type: "thread", thread });
            }
          } catch (error) {
            if (!stale()) onError(error);
          }
        }
      } catch (error) {
        if (!stale()) onError(error);
      }
    },
    close() {
      closed = true;
      generation++;
    },
  };
}
