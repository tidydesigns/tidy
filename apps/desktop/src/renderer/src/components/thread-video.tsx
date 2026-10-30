import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { DesktopAPI } from "../../../shared/contracts/desktop";
import { useVideoSource, type VideoInput } from "./use-video-source";
import "./video-preview.css";

export function ThreadVideo({
  api,
  input,
  name,
  active,
}: {
  api: DesktopAPI;
  input: VideoInput;
  name: string;
  active: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [nearby, setNearby] = useState(false);
  const [started, setStarted] = useState(false);
  const position = useRef(0);
  useEffect(() => {
    position.current = 0;
  }, [input.projectId, input.threadId, input.href]);
  useEffect(() => {
    const element = host.current;
    if (!active) {
      setNearby(false);
      setStarted(false);
      return;
    }
    if (!element) return;
    let observing = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!observing) return;
        const visible = entry?.isIntersecting ?? false;
        setNearby(visible);
        if (visible) setStarted(true);
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => {
      observing = false;
      observer.disconnect();
    };
  }, [active]);
  const enabled = active && started;
  const { state, retry, playbackFailed } = useVideoSource(api, input, enabled, nearby);
  return (
    <span className="thread-video" ref={host} role="group" aria-label={`Video: ${name}`}>
      <span className="thread-video-stage">
        {state.kind === "ready" ? (
          <video
            onTimeUpdate={(event) => {
              position.current = event.currentTarget.currentTime;
            }}
            onLoadedMetadata={(event) => {
              if (position.current > 0)
                event.currentTarget.currentTime = Math.min(
                  position.current,
                  event.currentTarget.duration,
                );
            }}
            src={state.url}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
            onError={playbackFailed}
          />
        ) : (
          <span className="thread-video-status" role={state.kind === "error" ? "alert" : "status"}>
            <svg
              aria-hidden="true"
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
            >
              <path d="m9 5 11 7-11 7V5Z" strokeLinejoin="round" />
            </svg>
            {state.kind === "unloaded" ? (
              <Button className="thread-video-retry" onClick={retry}>
                Load recording
              </Button>
            ) : state.kind === "loading" ? (
              <>
                <span className="text-xs">
                  {enabled ? "Loading recording…" : "Video recording"}
                </span>
                {enabled && (
                  <progress
                    aria-label="Loading recording"
                    max={state.total ?? 1}
                    value={state.total ? state.loaded : undefined}
                  />
                )}
                {state.total && (
                  <span className="text-xs text-muted-ink">
                    {Math.round((state.loaded / state.total) * 100)}%
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="text-sm">Unable to preview video</span>
                <span className="text-xs text-muted-ink">{state.message}</span>
                <Button className="thread-video-retry" onClick={retry}>
                  Try again
                </Button>
              </>
            )}
          </span>
        )}
      </span>
      <span className="thread-video-caption" title={input.href}>
        {name}
      </span>
    </span>
  );
}
