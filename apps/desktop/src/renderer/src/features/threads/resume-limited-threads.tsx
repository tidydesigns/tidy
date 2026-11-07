import { useCallback, useEffect, useMemo, useReducer } from "react";
import { showToast, useToastNotice } from "@tidy/ui/toast";
import type { DesktopAPI, Project, ProjectSnapshot } from "../../../../shared/contracts/desktop";
import { createThreadRecoveryState } from "./thread-recovery-state";

const noPendingDone: Record<string, boolean> = {};

/** Only an explicit click submits work; quota and thread events only update the notice. */
export function ResumeLimitedThreads({
  api,
  projects,
  snapshots,
  connected = true,
  pendingDone = noPendingDone,
}: {
  api?: DesktopAPI;
  projects: Project[];
  snapshots?: Record<string, ProjectSnapshot>;
  connected?: boolean;
  pendingDone?: Record<string, boolean>;
}) {
  const state = useMemo(createThreadRecoveryState, [api]);
  const [version, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    state.active = true;
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
      state.active = false;
      state.attempt = undefined;
      unsubscribe?.();
    };
  }, [api, state]);
  useEffect(() => {
    let changed = false;
    for (const snapshot of Object.values(snapshots ?? {}))
      changed = state.snapshot(snapshot, pendingDone) || changed;
    if (changed) refresh();
  }, [state, snapshots, pendingDone]);

  /** Read minimal eligibility once per project, coalescing overlapping discovery and revalidation. */
  const discover = useCallback(
    (projectId: string): Promise<void> => {
      if (!api?.threadRecoveryState) return Promise.resolve();
      const pending = state.reads.get(projectId);
      if (pending) return pending;
      const baseline = state.capture(projectId);
      const read = api
        .threadRecoveryState(projectId)
        .then((values) => {
          if (state.active && state.reconcile(projectId, values, baseline)) refresh();
        })
        .catch(() => {
          /* Keep actionable state when an older or disconnected host cannot confirm it. */
        })
        .finally(() => state.reads.delete(projectId));
      state.reads.set(projectId, read);
      return read;
    },
    [api, state],
  );
  const projectKey = [...new Set(projects.map((project) => project.id))].sort().join(",");
  useEffect(() => {
    if (!connected) return;
    let active = true;
    void (async () => {
      for (const id of projectKey ? projectKey.split(",") : []) {
        if (!active) return;
        await discover(id);
      }
    })();
    return () => {
      active = false;
    };
  }, [discover, projectKey, connected]);

  /** Submit only after a click; revalidate skipped work instead of assuming it recovered. */
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
          for (const id of result.resumed)
            if (state.limited.get(id)?.revision === revisions.get(id))
              changed = state.limited.delete(id) || changed;
          if (changed) refresh();
          resumed += result.resumed.length;
          failed += result.failed.length;
          failure ??= result.failed[0]?.error;
          await discover(project.id);
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
  }, [api, projects, state, discover]);

  const notice = useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    const affected = [...state.limited.values()].filter(
      (thread) => projectIds.has(thread.projectId) && !thread.hidden,
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
