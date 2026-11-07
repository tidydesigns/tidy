import { useCallback, useEffect, useMemo, useReducer } from "react";
import { showToast, useToastNotice } from "@tidy/ui/toast";
import type {
  DesktopAPI,
  Project,
  ProjectSnapshot,
  ThreadSummary,
} from "../../../../shared/contracts/desktop";
import { isLimitedThread } from "../../../../shared/models/thread-recovery";

type LimitedThread = Pick<ThreadSummary, "id" | "projectId" | "revision"> & { dismissed: boolean };

/** Revisions stay current without rerendering the notice for streaming or metadata updates. */
function recoveryState() {
  const revisions = new Map<string, number>();
  const limited = new Map<string, LimitedThread>();
  return {
    limited,
    attempt: undefined as symbol | undefined,
    receive(thread: ThreadSummary) {
      if ((revisions.get(thread.id) ?? -1) >= thread.revision) return false;
      revisions.set(thread.id, thread.revision);
      if (!isLimitedThread(thread)) return limited.delete(thread.id);
      const previous = limited.get(thread.id);
      if (previous?.projectId === thread.projectId) {
        previous.revision = thread.revision;
        return false;
      }
      limited.set(thread.id, {
        id: thread.id,
        projectId: thread.projectId,
        revision: thread.revision,
        dismissed: false,
      });
      return true;
    },
  };
}

/** Only an explicit click submits work; quota and thread events only update the notice. */
export function ResumeLimitedThreads({
  api,
  projects,
  snapshots,
}: {
  api?: DesktopAPI;
  projects: Project[];
  snapshots?: Record<string, ProjectSnapshot>;
}) {
  const state = useMemo(recoveryState, [api]);
  const [version, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    const unsubscribe = api?.onEvent((event) => {
      const thread =
        event.type === "thread-patch"
          ? event.summary
          : event.type === "thread" || event.type === "thread-summary"
            ? event.thread
            : null;
      if (thread && state.receive(thread)) refresh();
    });
    return () => {
      state.attempt = undefined;
      unsubscribe?.();
    };
  }, [api, state]);
  useEffect(() => {
    let changed = false;
    for (const snapshot of Object.values(snapshots ?? {}))
      for (const thread of snapshot.threads) changed = state.receive(thread) || changed;
    if (changed) refresh();
  }, [state, snapshots]);

  const resume = useCallback(async () => {
    if (state.attempt || !api?.resumeLimitedThreads) return;
    const token = Symbol();
    state.attempt = token;
    refresh();
    const revisions = new Map(
      [...state.limited.values()].map((thread) => [thread.id, thread.revision]),
    );
    let resumed = 0,
      failed = 0;
    let failure: string | undefined;
    try {
      // Sequential discovery bounds disk/network work and provider startup bursts.
      for (const project of projects) {
        if (state.attempt !== token) return;
        try {
          const result = await api.resumeLimitedThreads({ projectId: project.id });
          if (state.attempt !== token) return;
          let changed = false;
          for (const id of [...result.resumed, ...result.skipped])
            if (state.limited.get(id)?.revision === revisions.get(id))
              changed = state.limited.delete(id) || changed;
          if (changed) refresh();
          resumed += result.resumed.length;
          failed += result.failed.length;
          failure ??= result.failed[0]?.error;
        } catch (error) {
          failed++;
          failure ??= error instanceof Error ? error.message : undefined;
        }
      }
      if (state.attempt !== token) return;
      showToast(
        failed
          ? `Resumed ${resumed} thread${resumed === 1 ? "" : "s"}. Some threads could not resume. ${failure?.slice(0, 240) || "Check your connection before trying again."}`
          : resumed
            ? `Resumed ${resumed} thread${resumed === 1 ? "" : "s"}.`
            : "No limited threads need to resume.",
        failed ? "error" : "success",
      );
    } finally {
      if (state.attempt === token) {
        state.attempt = undefined;
        refresh();
      }
    }
  }, [api, projects, state]);

  const notice = useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    const affected = [...state.limited.values()].filter((thread) =>
      projectIds.has(thread.projectId),
    );
    if (!api?.resumeLimitedThreads || !affected.some((thread) => !thread.dismissed)) return null;
    return {
      message: `${affected.length} thread${affected.length === 1 ? " is" : "s are"} blocked by provider limits. Resume when your allowance is available.`,
      tone: "info" as const,
      onDismiss: () => {
        for (const thread of affected) {
          const current = state.limited.get(thread.id);
          if (current === thread) current.dismissed = true;
        }
        refresh();
      },
      action: {
        label: state.attempt ? "Resuming…" : "Resume all",
        onClick: () => void resume(),
        disabled: Boolean(state.attempt),
      },
    };
  }, [api, projects, state, version, resume]);
  useToastNotice(notice);
  return null;
}
