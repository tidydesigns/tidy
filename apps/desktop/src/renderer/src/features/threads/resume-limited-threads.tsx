import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { showToast } from "@tidy/ui/toast";
import type { DesktopAPI, Project } from "../../../../shared/contracts/desktop";
import { isLimitedThread } from "../../../../shared/models/thread-recovery";

/** Only explicit clicks initiate recovery; observing a quota reset never submits work. */
export function ResumeLimitedThreads({ api, projects }: { api?: DesktopAPI; projects: Project[] }) {
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    active.current = false;
    setPending(false);
    return () => {
      generation.current++;
    };
  }, [api]);
  if (!api?.projectSnapshot || !api.resumeLimitedThreads || !projects.length) return null;

  async function resume() {
    if (active.current || !api?.projectSnapshot || !api.resumeLimitedThreads) return;
    active.current = true;
    setPending(true);
    const version = generation.current;
    let resumed = 0;
    let failed = 0;
    try {
      // Sequential project discovery bounds disk/network work and provider startup bursts.
      for (const project of projects) {
        if (generation.current !== version) return;
        try {
          const snapshot = await api.projectSnapshot(project.id);
          if (generation.current !== version) return;
          const threads = snapshot.threads
            .filter(isLimitedThread)
            .map((thread) => ({ threadId: thread.id, revision: thread.revision }));
          for (let offset = 0; offset < threads.length; offset += 1000) {
            if (generation.current !== version) return;
            const result = await api.resumeLimitedThreads({
              projectId: project.id,
              threads: threads.slice(offset, offset + 1000),
            });
            resumed += result.resumed.length;
            failed += result.failed.length;
          }
        } catch {
          failed++;
        }
      }
      if (generation.current !== version) return;
      showToast(
        failed
          ? `Resumed ${resumed} thread${resumed === 1 ? "" : "s"}. Some threads could not resume; check their errors and connection before trying again.`
          : resumed
            ? `Resumed ${resumed} thread${resumed === 1 ? "" : "s"}.`
            : "No limited threads need to resume.",
        failed ? "error" : "success",
      );
    } finally {
      if (generation.current === version) {
        active.current = false;
        setPending(false);
      }
    }
  }

  return (
    <Button
      className="mx-3 mb-2 shrink-0 text-xs"
      disabled={pending}
      aria-busy={pending}
      title="Resume all unfinished threads blocked by usage or rate limits across projects on this machine. Use after your allowance is available."
      onClick={() => void resume()}
    >
      {pending ? "Resuming limited threads…" : "Resume all limited threads"}
    </Button>
  );
}
