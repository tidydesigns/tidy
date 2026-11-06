import { subscribePullRequestRefresh } from "./pull-request-refresh";
import { pullRequestStatus, type StatusAPI } from "./pull-request-status";
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore, type Ref } from "react";
import { NavigationScope } from "../app/session-state";
import type { PullRequestState } from "../../../shared/contracts/pull-request";

export function PullRequestIcon({
  url,
  api,
  projectId,
}: {
  url: string;
  api: StatusAPI;
  projectId: string;
}) {
  const element = useRef<SVGSVGElement>(null);
  const scope = useContext(NavigationScope);
  const status = useMemo(
    () => pullRequestStatus({ api, projectId, url, scope }),
    [api, projectId, url, scope],
  );
  const { state, checking } = useSyncExternalStore(status.subscribe, status.read, status.read);
  useEffect(() => {
    if (!api.pullRequestState) return;
    let unsubscribe: (() => void) | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        unsubscribe ??= subscribePullRequestRefresh(status.refresh);
        if (document.visibilityState !== "hidden") void status.refresh();
      } else {
        unsubscribe?.();
        unsubscribe = undefined;
      }
    });
    if (element.current) observer.observe(element.current);
    return () => {
      unsubscribe?.();
      observer.disconnect();
    };
  }, [api, status]);
  return <PullRequestGlyph state={state} checking={checking} iconRef={element} />;
}

export function PullRequestGlyph({
  state,
  iconRef,
  checking = false,
}: {
  state: PullRequestState | null;
  iconRef?: Ref<SVGSVGElement>;
  checking?: boolean;
}) {
  const label = state
    ? `${state[0]?.toUpperCase()}${state.slice(1)} pull request`
    : checking
      ? "Checking pull request status"
      : "Pull request · status unavailable";
  return (
    <svg
      ref={iconRef}
      role="img"
      aria-label={label}
      className="chat-link-icon chat-pull-request-icon"
      data-state={state ?? "unknown"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>{label}</title>
      <circle cx="4" cy="3" r="1.75" />
      <circle cx="12" cy="13" r="1.75" />
      {state === "merged" ? (
        <>
          <path d="M4 5v3a5 5 0 0 0 5 5h1M4 5v6" />
          <circle cx="4" cy="13" r="1.75" />
        </>
      ) : state === "closed" ? (
        <>
          <path d="M4 5v6M10 2l4 4m0-4-4 4M12 8v3" />
          <circle cx="4" cy="13" r="1.75" />
        </>
      ) : (
        <>
          <path
            d="M4 5v6M12 11V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2"
            strokeDasharray={state === "draft" ? "2 2" : undefined}
          />
          <circle cx="4" cy="13" r="1.75" />
        </>
      )}
    </svg>
  );
}
