import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { showToast } from "@tidy/ui/toast";
import type { DesktopAPI, Project } from "../../../../shared/contracts/desktop";

/** Only explicit clicks initiate recovery; observing a quota reset never submits work. */
export function ResumeLimitedThreads({ api, projects }: { api?: DesktopAPI; projects: Project[] }) {
  const [pending, setPending] = useState(false);
  const attempt = useRef<symbol | undefined>(undefined);
  useEffect(() => {
    attempt.current = undefined;
    setPending(false);
    return () => {
      attempt.current = undefined;
    };
  }, [api]);
  if (!api?.resumeLimitedThreads || !projects.length) return null;

  async function resume() {
    if (attempt.current || !api?.resumeLimitedThreads) return;
    const token = Symbol();
    attempt.current = token;
    setPending(true);
    let resumed = 0;
    let failed = 0;
    let failure: string | undefined;
    try {
      // Sequential project discovery bounds disk/network work and provider startup bursts.
      for (const project of projects) {
        if (attempt.current !== token) return;
        try {
          const result = await api.resumeLimitedThreads({ projectId: project.id });
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
