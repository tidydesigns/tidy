import { useEffect, useRef, useState } from "react";
import { showToast, dismissToast } from "@tidy/ui/toast";
import type {
  DesktopAPI,
  Project,
  ProjectSnapshot,
  ThreadSummary,
} from "../../../../shared/contracts/desktop";
import { isLimitedThread } from "../../../../shared/models/thread-recovery";

/** Only explicit clicks initiate recovery; observing a quota reset never submits work. */
export function ResumeLimitedThreads({
  api,
  projects,
  snapshots = {},
}: {
  api?: DesktopAPI;
  projects: Project[];
  snapshots?: Record<string, ProjectSnapshot>;
}) {
  const [limited, setLimited] = useState<Record<string, ThreadSummary>>({});
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const seen = useRef(new Map<string, number>());
  const owner = useRef({});
  const receive = (thread: ThreadSummary) => {
    if ((seen.current.get(thread.id) ?? -1) >= thread.revision) return;
    seen.current.set(thread.id, thread.revision);
    const blocked = isLimitedThread(thread);
    if (!blocked)
      setDismissed((current) => {
        if (!current[thread.id]) return current;
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
    setLimited((current) => {
      if (blocked) return { ...current, [thread.id]: thread };
      if (!current[thread.id]) return current;
      const next = { ...current };
      delete next[thread.id];
      return next;
    });
  };
  useEffect(() => {
    setLimited({});
    setDismissed({});
    seen.current.clear();
    return api?.onEvent((event) => {
      if (event.type === "thread" || event.type === "thread-summary") receive(event.thread);
      else if (event.type === "thread-patch") receive(event.summary);
    });
  }, [api]);
  useEffect(() => {
    for (const snapshot of Object.values(snapshots))
      for (const thread of snapshot.threads) receive(thread);
  }, [api, snapshots]);
  const [pending, setPending] = useState(false);
  const attempt = useRef<symbol | undefined>(undefined);
  useEffect(() => {
    attempt.current = undefined;
    setPending(false);
    return () => {
      attempt.current = undefined;
    };
  }, [api]);

  async function resume() {
    if (attempt.current || !api?.resumeLimitedThreads) return;
    const token = Symbol();
    attempt.current = token;
    setPending(true);
    const revisions = new Map(Object.values(limited).map((thread) => [thread.id, thread.revision]));
    let resumed = 0;
    let failed = 0;
    let failure: string | undefined;
    try {
      // Sequential project discovery bounds disk/network work and provider startup bursts.
      for (const project of projects) {
        if (attempt.current !== token) return;
        try {
          const result = await api.resumeLimitedThreads({ projectId: project.id });
          if (attempt.current !== token) return;
          setLimited((current) => {
            const next = { ...current };
            for (const id of [...result.resumed, ...result.skipped])
              if (next[id]?.revision === revisions.get(id)) delete next[id];
            return next;
          });
          resumed += result.resumed.length;
          failed += result.failed.length;
          failure ??= result.failed[0]?.error;
        } catch (error) {
          failed++;
          failure ??= error instanceof Error ? error.message : undefined;
        }
      }
      if (attempt.current !== token) return;
      showToast(
        failed
          ? `Resumed ${resumed} thread${resumed === 1 ? "" : "s"}. Some threads could not resume. ${failure?.slice(0, 240) || "Check your connection before trying again."}`
          : resumed
            ? `Resumed ${resumed} thread${resumed === 1 ? "" : "s"}.`
            : "No limited threads need to resume.",
        failed ? "error" : "success",
      );
    } finally {
      if (attempt.current === token) {
        attempt.current = undefined;
        setPending(false);
      }
    }
  }

  const affected = Object.values(limited).filter((thread) =>
    projects.some((project) => project.id === thread.projectId),
  );
  const signature = affected
    .map((thread) => thread.id)
    .sort()
    .join(",");
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const visible = affected.some((thread) => !dismissed[thread.id]);
  useEffect(() => {
    if (!api?.resumeLimitedThreads || !visible) return;
    const id = showToast(
      `${affected.length} thread${affected.length === 1 ? " is" : "s are"} blocked by provider limits. Resume when your allowance is available.`,
      "info",
      () =>
        setDismissed((current) => ({
          ...current,
          ...Object.fromEntries(affected.map((thread) => [thread.id, true])),
        })),
      owner.current,
      {
        label: pending ? "Resuming…" : "Resume all",
        onClick: () => void resumeRef.current(),
        disabled: pending,
      },
    );
    return () => dismissToast(id);
  }, [api, signature, visible, pending]);
  return null;
}
