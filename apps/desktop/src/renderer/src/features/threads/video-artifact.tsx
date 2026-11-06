import { memo, useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type {
  VideoArtifact as Artifact,
  VideoVariant,
} from "../../../../shared/contracts/video-artifacts";

export const VideoArtifact = memo(function VideoArtifact({
  artifact,
  api,
  projectId,
  threadId,
  active,
}: {
  artifact: Artifact;
  api: DesktopAPI;
  projectId: string;
  threadId: string;
  active: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [nearby, setNearby] = useState(false);
  const [urls, setURLs] = useState<Partial<Record<VideoVariant, string>>>({});
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const reference = { projectId, threadId, artifactId: artifact.id };
  useEffect(() => {
    if (!active || !element.current) return;
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), {
      rootMargin: "240px",
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active || !nearby) player.current?.pause();
  }, [active, nearby]);
  useEffect(() => {
    if (!active || !nearby || !api.videoURL) return;
    let disposed = false;
    const variants: VideoVariant[] = [
      ...(artifact.original ? ["original" as const] : []),
      ...(artifact.status === "ready" ? ["playback" as const] : []),
      ...(artifact.poster ? ["poster" as const] : []),
    ];
    // A missing or slow poster/download must not hold back an otherwise playable video.
    for (const variant of variants)
      void api
        .videoURL({ projectId, threadId, artifactId: artifact.id }, variant)
        .then((url) => {
          if (!disposed) {
            setURLs((current) => ({ ...current, [variant]: url }));
            if (variant === "playback") setError(undefined);
          }
        })
        .catch(() => {
          if (
            !disposed &&
            (variant === "playback" || (variant === "original" && artifact.status !== "ready"))
          )
            setError("Video playback is unavailable. Reconnect to its host and reopen the thread.");
        });
    return () => {
      disposed = true;
    };
  }, [
    api,
    projectId,
    threadId,
    artifact.id,
    artifact.status,
    artifact.original?.size,
    artifact.poster,
    active,
    nearby,
  ]);
  const pending = !cancelled && (artifact.status === "queued" || artifact.status === "processing");
  return (
    <div
      ref={element}
      className="my-3 max-w-3xl overflow-hidden rounded-lg border border-border bg-panel"
      aria-label={`Video: ${artifact.name}`}
    >
      {artifact.status === "ready" && urls.playback && (
        <video
          ref={player}
          src={urls.playback}
          poster={urls.poster}
          controls
          playsInline
          preload="none"
          aria-label={artifact.name}
          width={artifact.width}
          height={artifact.height}
          className="block max-h-[480px] w-full bg-black object-contain"
          onError={() =>
            setError(
              "This video cannot be played here. Download the original to open it in another player.",
            )
          }
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-muted-ink">
        <span className="min-w-0 truncate text-ink">{artifact.name}</span>
        {pending && (
          <span role="status">
            {artifact.status === "queued" ? "Queued for preview" : "Preparing preview…"}
          </span>
        )}
        {((cancelled && ["queued", "processing"].includes(artifact.status)) ||
          artifact.status === "cancelled") && <span role="status">Preview cancelled</span>}
        {artifact.status === "ready" && (
          <span>
            {artifact.width} × {artifact.height} · {Math.round(artifact.duration ?? 0)}s
          </span>
        )}
        {urls.original && (
          <a
            className="ml-auto underline underline-offset-2"
            href={urls.original}
            download={artifact.name}
          >
            Download original
          </a>
        )}
        {pending && api.cancelVideo && (
          <Button
            variant="text"
            className="text-xs underline underline-offset-2"
            onClick={() => {
              setCancelled(true);
              void api.cancelVideo!(reference).catch(() => {
                setCancelled(false);
                setError("Could not cancel the preview. Try again.");
              });
            }}
          >
            Cancel preview
          </Button>
        )}
      </div>
      {(artifact.error || error) && (
        <p role="status" className="m-0 px-3 pb-2 text-xs text-muted-ink">
          {error ?? artifact.error}
        </p>
      )}
    </div>
  );
});
