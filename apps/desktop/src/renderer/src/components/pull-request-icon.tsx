import { useEffect, useRef, useState, type Ref } from "react";
import type { DesktopAPI } from "../../../shared/contracts/desktop";
import type { PullRequestState } from "../../../shared/contracts/pull-request";

export function PullRequestIcon({
  url,
  api,
  projectId,
}: {
  url: string;
  api: Pick<DesktopAPI, "pullRequestState">;
  projectId: string;
}) {
  const element = useRef<SVGSVGElement>(null);
  const key = `${projectId}:${url}`;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    api: Pick<DesktopAPI, "pullRequestState">;
    state: PullRequestState | null;
    checking: boolean;
  } | null>(null);
  const matching = snapshot?.key === key && snapshot.api === api;
  const state = matching ? snapshot.state : null;
  const checking = matching && snapshot.checking;
  useEffect(() => {
    if (!api.pullRequestState) return;
    let current = true;
    let visible = false;
    let refreshing = false;
    const refresh = async () => {
      if (!visible || refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      setSnapshot((previous) => ({
        key,
        api,
        checking: true,
        state: previous?.key === key && previous.api === api ? previous.state : null,
      }));
      try {
        const value = await api.pullRequestState?.(projectId, url);
        if (current) setSnapshot({ key, api, state: value ?? null, checking: false });
      } catch {
        if (current) setSnapshot({ key, api, state: null, checking: false });
      } finally {
        refreshing = false;
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) void refresh();
    });
    if (element.current) observer.observe(element.current);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      observer.disconnect();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, projectId, url, key]);
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
