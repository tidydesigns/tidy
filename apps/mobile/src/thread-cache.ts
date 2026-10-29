import type { DesktopEvent, ProjectSnapshot, Thread } from "@tidy/agent-protocol/contracts/desktop";
import {
  applyThreadPatch,
  applyProjectEvent,
  type ThreadPatch,
} from "@tidy/agent-protocol/models/thread-updates";

export class ThreadCache {
  readonly projects = new Map<string, ProjectSnapshot>();
  readonly threads = new Map<string, Thread>();
  private patches = new Map<string, ThreadPatch[]>();
  putProject(snapshot: ProjectSnapshot) {
    const previous = this.projects.get(snapshot.project.id);
    // A refresh must not replace newer streaming summaries.
    if (previous) {
      const ids = new Set(snapshot.threads.map((thread) => thread.id));
      snapshot = {
        ...snapshot,
        threads: [
          ...snapshot.threads.map((thread) => {
            const live = previous.threads.find((value) => value.id === thread.id);
            return live && live.revision > thread.revision ? live : thread;
          }),
          ...previous.threads.filter((thread) => !ids.has(thread.id)),
        ],
      };
    }
    this.projects.set(snapshot.project.id, snapshot);
  }
  putThread(thread: Thread) {
    for (const patch of this.patches.get(thread.id) ?? []) thread = applyThreadPatch(thread, patch);
    this.patches.delete(thread.id);
    const previous = this.threads.get(thread.id);
    if (previous && previous.revision > thread.revision) return;
    this.threads.delete(thread.id);
    this.threads.set(thread.id, thread);
    if (this.threads.size > 20) this.threads.delete(this.threads.keys().next().value!);
    const snapshot = this.projects.get(thread.projectId);
    if (snapshot)
      this.projects.set(thread.projectId, applyProjectEvent(snapshot, { type: "thread", thread }));
  }
  event(event: DesktopEvent) {
    const projectId = event.type === "designs" ? event.projectId : event.thread.projectId;
    const snapshot = this.projects.get(projectId);
    if (snapshot) this.projects.set(projectId, applyProjectEvent(snapshot, event));
    if (event.type === "thread") this.putThread(event.thread);
    if (event.type === "thread-patch") {
      const previous = this.threads.get(event.thread.id);
      if (previous) this.putThread(applyThreadPatch(previous, event));
      else {
        const patches = this.patches.get(event.thread.id) ?? [];
        this.patches.set(event.thread.id, [...patches.slice(-31), event]);
        if (this.patches.size > 20) this.patches.delete(this.patches.keys().next().value!);
      }
    }
  }
}
