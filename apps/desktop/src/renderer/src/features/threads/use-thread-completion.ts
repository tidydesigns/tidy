import { useEffect } from "react";
import type { DesktopAPI, Project } from "../../../../shared/contracts/desktop";
import {
  currentThreadCompletion,
  subscribeThreadCompletion,
} from "../settings/thread-completion-preferences";

/** Background checks never delay navigation or load conversations into the renderer. */
export function useThreadCompletion(
  api: DesktopAPI | undefined,
  projects: Project[],
  connected: boolean,
) {
  const projectIds = JSON.stringify(projects.map((project) => project.id).sort());
  useEffect(() => {
    if (!api?.autoCompleteThreads || !connected) return;
    let disposed = false;
    const check = () => {
      const preferences = currentThreadCompletion();
      for (const projectId of JSON.parse(projectIds) as string[]) {
        if (disposed) return;
        void api.autoCompleteThreads!(projectId, preferences).catch(() => {});
      }
    };
    check();
    const unsubscribe = subscribeThreadCompletion(check);
    const timer = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [api, projectIds, connected]);
}
