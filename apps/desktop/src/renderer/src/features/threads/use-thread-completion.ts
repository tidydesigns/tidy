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

/** Background checks never delay navigation or load conversations into the renderer. */
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
    const check = (only?: string, force = false) => {
      const preferences = currentThreadCompletion();
      for (const projectId of JSON.parse(projectIds) as string[]) {
        if (disposed) return;
        if (only && projectId !== only) continue;
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
    const retry = subscribeCompletionRetry(() => check(undefined, true));
    const refresh = subscribePullRequestRefresh((force) => check(undefined, force));
    const settled = new Map<string, string>();
    const events = api.onEvent?.((event) => {
      if (event.type === "pull-request-state") {
        if (event.state === "merged" || event.state === "closed") check(event.projectId);
        return;
      }
      if (
        (event.type === "thread" ||
          event.type === "thread-summary" ||
          event.type === "thread-patch") &&
        !event.thread.doneAt &&
        ["completed", "idle", "stopped"].includes(event.thread.status)
      ) {
        const summary =
          event.type === "thread-patch"
            ? event.summary
            : event.type === "thread-summary"
              ? event.thread
              : undefined;
        const key = JSON.stringify([
          summary?.queuedMessageCount ??
            (event.type === "thread" ? event.thread.queuedMessages?.length : undefined),
          summary?.pendingApprovalCount ??
            (event.type === "thread" ? event.thread.pendingApprovals?.length : undefined),
          event.thread.status,
          event.thread.pullRequests,
          event.thread.autoDoneAfter,
        ]);
        if (settled.get(event.thread.id) === key) return;
        settled.set(event.thread.id, key);
        check(event.thread.projectId, true);
      } else if (
        event.type === "thread" ||
        event.type === "thread-summary" ||
        event.type === "thread-patch"
      ) {
        settled.delete(event.thread.id);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      retry();
      events?.();
      clearCompletionHealth(scope);
      refresh();
    };
  }, [api, projectIds, connected]);
}
