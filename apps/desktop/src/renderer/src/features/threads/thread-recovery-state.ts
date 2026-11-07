import type { ProjectSnapshot, ThreadSummary } from "../../../../shared/contracts/desktop";
import type { ThreadRecoveryState } from "../../../../shared/contracts/thread-recovery";
import { isLimitedThread } from "../../../../shared/models/thread-recovery";

type LimitedThread = ThreadRecoveryState & { dismissed: boolean; hidden: boolean };
type Source = "event" | "snapshot" | "optimistic" | "read";
type ReadBaseline = Map<string, { thread: LimitedThread; revision: number }>;

/** Keep host revisions authoritative while reconciling optimistic UI and bounded background reads. */
export function createThreadRecoveryState() {
  const revisions = new Map<string, number>();
  const snapshots = new Map<string, Map<string, number>>();
  const limited = new Map<string, LimitedThread>();
  const state = {
    limited,
    active: false,
    pendingDone: {} as Record<string, boolean>,
    attempt: undefined as symbol | undefined,
    reads: new Map<string, Promise<void>>(),
    /** Apply equal-revision snapshots for rollbacks, but never accept an older host event. */
    receiveState(value: ThreadRecoveryState, source: Source = "event"): boolean {
      const previousRevision = revisions.get(value.id) ?? -1;
      if (
        value.revision < previousRevision ||
        (source === "event" && value.revision === previousRevision)
      )
        return false;
      if (source === "read" && state.pendingDone[value.id] && value.revision <= previousRevision)
        return false;
      if (source !== "optimistic") revisions.set(value.id, value.revision);
      const previous = limited.get(value.id);
      if (!value.limited) {
        if (source !== "optimistic") return limited.delete(value.id);
        if (!previous || previous.hidden) return false;
        previous.hidden = true;
        return true;
      }
      if (previous?.projectId === value.projectId) {
        previous.revision = value.revision;
        const changed = previous.hidden;
        previous.hidden = false;
        return changed;
      }
      limited.set(value.id, { ...value, dismissed: false, hidden: false });
      return true;
    },
    /** Classify thread summaries without retaining titles, errors, previews or provider data. */
    receive(thread: ThreadSummary, source: Source = "event"): boolean {
      return state.receiveState(
        {
          id: thread.id,
          projectId: thread.projectId,
          revision: thread.revision,
          limited: isLimitedThread(thread),
        },
        source,
      );
    },
    /** Reconcile omissions only when no newer event superseded the previously rendered snapshot. */
    snapshot(snapshot: ProjectSnapshot, pendingDone: Record<string, boolean>): boolean {
      state.pendingDone = pendingDone;
      const projectId = snapshot.project.id;
      const previous = snapshots.get(projectId);
      const current = new Map(snapshot.threads.map((thread) => [thread.id, thread.revision]));
      let changed = false;
      for (const thread of snapshot.threads)
        changed =
          state.receive(thread, pendingDone[thread.id] ? "optimistic" : "snapshot") || changed;
      for (const [id, revision] of previous ?? []) {
        if (!current.has(id) && !pendingDone[id] && revisions.get(id) === revision)
          changed = limited.delete(id) || changed;
      }
      snapshots.set(projectId, current);
      return changed;
    },
    /** Fence read omissions against events received after the request began. */
    capture(projectId: string): ReadBaseline {
      return new Map(
        [...limited.values()]
          .filter((thread) => thread.projectId === projectId)
          .map((thread) => [thread.id, { thread, revision: thread.revision }]),
      );
    },
    /** Accept authoritative read results without erasing newer failures that arrived in flight. */
    reconcile(projectId: string, values: ThreadRecoveryState[], baseline: ReadBaseline): boolean {
      let changed = false;
      const present = new Set<string>();
      for (const value of values) {
        if (value.projectId !== projectId) continue;
        present.add(value.id);
        changed = state.receiveState(value, "read") || changed;
      }
      for (const [id, before] of baseline) {
        const current = limited.get(id);
        if (
          !present.has(id) &&
          !state.pendingDone[id] &&
          current &&
          current === before.thread &&
          current.revision === before.revision
        )
          changed = limited.delete(id) || changed;
      }
      return changed;
    },
  };
  return state;
}
