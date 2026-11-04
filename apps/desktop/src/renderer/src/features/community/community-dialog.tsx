import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { Button } from "@tidy/ui/button";
import type { CommunityAPI } from "../../../../shared/contracts/community";
import coral from "./cloud-coral.avif";
import spectrum from "./cloud-spectrum.avif";
import "./community-dialog.css";

type Phase = "ask" | "starring" | "success" | "opening" | "open-error";

const cloudCharacters = [
  "                                ",
  "                                ",
  "                                ",
  "...                             ",
  ",,.,                            ",
  ",,,.                         ..,",
  ",,::+.                    ..,:,,",
  ".. ,:.    .             .   .::.",
  "::. ,,,....                ::,,,",
  ":+*  ..:,               . .:,.::",
  ".,+:,: .:::.           .,:,,::+,",
  ",..,:*:..,...          ....:+,.,",
  ":,  ,,:+:::,,.     .,.. .:::,...",
  ":,:, ...::.:++:,,...,...:++: ..",
  " .+..,,.  ..::..,,::,,::....   .",
  " .,,:.  ...  ,::,::,..       .,,",
  "    .,..:::,. .,:,:::: ..   ,.",
  "           ....   ..,::,,,.",
].join("\n");

function Celebration() {
  return (
    <div className="community-celebration" aria-hidden="true">
      {Array.from({ length: 24 }, (_, index) => {
        const angle = (index / 24) * Math.PI * 2;
        const distance = 70 + (index % 5) * 22;
        const style: CSSProperties &
          Record<"--piece-x" | "--piece-y" | "--piece-rotation", string> = {
          "--piece-x": `${Math.cos(angle) * distance}px`,
          "--piece-y": `${Math.sin(angle) * distance - 30}px`,
          "--piece-rotation": `${(index % 2 ? -1 : 1) * (120 + index * 15)}deg`,
          animationDelay: `${(index % 4) * 30}ms`,
        };
        const character = index % 3 === 0 ? ["+", ".", "*"][Math.floor(index / 3) % 3] : null;
        return (
          <span
            className={`community-piece${character ? " community-piece-ascii" : ""}`}
            key={index}
            style={style}
          >
            {character}
          </span>
        );
      })}
    </div>
  );
}

export default function CommunityDialog({
  api,
  onDismiss,
  onSuccess,
}: {
  api: CommunityAPI;
  onDismiss(): void;
  onSuccess(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const dismissButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [phase, setPhase] = useState<Phase>("ask");
  const success = phase === "success";
  const browser = phase === "opening" || phase === "open-error";

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    dismissButton.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
    };
  }, []);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => dialog.current?.close(), 4000);
    return () => clearTimeout(timer);
  }, [success]);

  const starOrOpen = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (phase !== "open-error") {
        setPhase("starring");
        const starred = await api.star().catch(() => false);
        if (!dialog.current?.open) return;
        if (starred) {
          onSuccess();
          setPhase("success");
          return;
        }
      }
      setPhase("opening");
      await api.open();
      dialog.current?.close();
    } catch {
      if (dialog.current?.open) setPhase("open-error");
    } finally {
      pending.current = false;
    }
  };

  return (
    <Dialog
      ref={dialog}
      size="sm"
      padded={false}
      className="community-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={(event) => {
        if (!event.currentTarget.open) onDismiss();
      }}
    >
      <div className="community-artwork" aria-hidden="true">
        <img src={coral} className="community-cloud community-cloud-coral" alt="" />
        <img src={spectrum} className="community-cloud community-cloud-spectrum" alt="" />
        <pre className="community-ascii community-ascii-left">{cloudCharacters}</pre>
        <pre className="community-ascii community-ascii-right">{cloudCharacters}</pre>
        <span className="community-wordmark">Tidy</span>
      </div>
      <Button
        type="button"
        className="community-close"
        aria-label="Close invitation"
        onClick={() => dialog.current?.close()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 6 12 12M6 18 18 6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </Button>
      <div className="community-copy" aria-live="polite" aria-atomic="true">
        <h2 id={`${id}-title`}>{success ? "Thanks for the star!" : "Enjoying Tidy?"}</h2>
        <p id={`${id}-description`}>
          {success
            ? "You’re helping Tidy grow. Thanks for being part of it."
            : phase === "open-error"
              ? "Couldn’t open your browser. Please try again."
              : browser
                ? "You can add your star in your browser instead."
                : "A star helps more people find Tidy and supports what we’re building."}
        </p>
      </div>
      <div className="community-actions">
        {success ? (
          <Button
            type="button"
            className="secondary-button"
            onClick={() => dialog.current?.close()}
          >
            Back to work
          </Button>
        ) : (
          <>
            <Button
              type="button"
              className="secondary-button"
              ref={dismissButton}
              onClick={() => dialog.current?.close()}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              className="community-star-button"
              disabled={phase === "starring" || phase === "opening"}
              onClick={() => void starOrOpen()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              {phase === "starring"
                ? "Starring…"
                : phase === "opening"
                  ? "Opening…"
                  : browser
                    ? "Open GitHub"
                    : "Star on GitHub"}
            </Button>
          </>
        )}
      </div>
      {success && <Celebration />}
    </Dialog>
  );
}
