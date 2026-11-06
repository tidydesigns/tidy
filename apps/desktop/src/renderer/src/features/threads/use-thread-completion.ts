import { subscribePullRequestRefresh } from "../../components/pull-request-refresh";
import { useEffect, useRef } from "react";
import {
  clearCompletionHealth,
  reportCompletionHealth,
  subscribeCompletionRetry,
} from "../settings/thread-completion-health";
import type { DesktopAPI, Project } from "../../../../shared/contracts/desktop";
import {
  currentThreadCompletion,
  subscribeThreadCompletion,
} from "../settings/thread-completion-preferences";

/** Register rules and recover missed external changes; merge/idle triggers live in the host. */
export function useThreadCompletion(
  api: DesktopAPI | undefined,
  projects: Project[],
  connected: boolean,
) {
  const owner = useRef({});
  const projectIds = JSON.stringify(projects.map((project) => project.id).sort());
  const names = useRef(projects);
  names.current = projects;
  useEffect(() => {
    if (!api?.autoCompleteThreads || !connected) return;
    const scope = owner.current;
    let disposed = false;
    const requests = new Map<string, object>();
    const check = (force = false) => {
      const preferences = currentThreadCompletion();
      for (const projectId of JSON.parse(projectIds) as string[]) {
        if (disposed) return;
        const request = {};
        requests.set(projectId, request);
        const report = (failed: boolean) => {
          if (!disposed && requests.get(projectId) === request)
            reportCompletionHealth(
              scope,
              projectId,
              names.current.find((project) => project.id === projectId)?.name ?? "Project",
              failed,
            );
        };
        void api.autoCompleteThreads!(projectId, preferences, force).then(
          () => report(false),
          () => report(true),
        );
      }
    };
    check();
    const all = () => check();
    const unsubscribe = subscribeThreadCompletion(all);
    const retry = subscribeCompletionRetry(() => check(true));
    const refresh = subscribePullRequestRefresh((force) => check(force));
    return () => {
      disposed = true;
      unsubscribe();
      retry();
      clearCompletionHealth(scope);
      refresh();
    };
  }, [api, projectIds, connected]);
}
