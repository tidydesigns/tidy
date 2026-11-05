import { useRef, useState, type RefObject } from "react";
import { Button } from "@tidy/ui/button";
import { MediaViewer } from "./media-viewer";

export function VideoPreview({
  src,
  name,
  position,
  onError,
}: {
  src: string;
  name: string;
  position: RefObject<number>;
  onError(): void;
}) {
  const displayName = name.trim() || "Video";
  const [expanded, setExpanded] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const playback = useRef({ playing: false, volume: 1, muted: false, rate: 1 });
  function transferPlayback() {
    const element = video.current;
    if (!element) return;
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      element.pause();
      return;
    }
    position.current = element.currentTime;
    playback.current = {
      playing: !element.paused && !element.ended,
      volume: element.volume,
      muted: element.muted,
      rate: element.playbackRate,
    };
    element.pause();
  }
  const player = (
    <video
      className="media-preview-video block size-full min-h-0 rounded-[6px] bg-black object-contain"
      ref={video}
      src={src}
      controls
      controlsList="nofullscreen"
      playsInline
      preload="metadata"
      aria-label={displayName}
      onTimeUpdate={(event) => {
        position.current = event.currentTarget.currentTime;
      }}
      onLoadedMetadata={(event) => {
        const element = event.currentTarget;
        if (position.current > 0)
          element.currentTime = Number.isFinite(element.duration)
            ? Math.min(position.current, element.duration)
            : position.current;
        element.volume = playback.current.volume;
        element.muted = playback.current.muted;
        element.playbackRate = playback.current.rate;
        if (playback.current.playing) void element.play().catch(() => {});
      }}
      onError={onError}
    />
  );
  return (
    <>
      {expanded ? (
        <MediaViewer
          kind="video"
          name={displayName}
          onClose={() => {
            transferPlayback();
            setExpanded(false);
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          {player}
        </MediaViewer>
      ) : (
        player
      )}
      <Button
        ref={trigger}
        type="button"
        aria-label={`Expand video preview: ${displayName}`}
        aria-haspopup="dialog"
        className="absolute top-2 right-2 grid size-10 cursor-pointer place-items-center rounded-lg border border-white/30 bg-black/70 text-white hover:bg-black/90 focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => {
          transferPlayback();
          setExpanded(true);
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <path
            d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>
    </>
  );
}
