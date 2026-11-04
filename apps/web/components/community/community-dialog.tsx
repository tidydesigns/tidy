import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import styles from "./community-dialog.module.css";

const cloudCharacters = [
  "...                             ",
  ",,.,                            ",
  ",,,.                         ..,",
  ",,::+.                    ..,:,,:",
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

export default function CommunityDialog({ onDismiss }: { onDismiss(): void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    let shown = false;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.removedNodes.length > 0)) show();
    });
    const show = () => {
      if (
        shown ||
        !element ||
        document.visibilityState !== "visible" ||
        document.querySelector("dialog[open]")
      )
        return;
      shown = true;
      observer.disconnect();
      element.showModal();
      dismiss.current?.focus({ preventScroll: true });
    };
    // Wait for privacy choices or another modal without stacking over it.
    const onClose = (event: Event) => {
      if (event.target !== element) show();
    };
    observer.observe(document.body, { childList: true, subtree: true });
    show();
    document.addEventListener("close", onClose, true);
    document.addEventListener("visibilitychange", show);
    return () => {
      observer.disconnect();
      document.removeEventListener("close", onClose, true);
      document.removeEventListener("visibilitychange", show);
      element?.close();
    };
  }, []);

  return (
    <Dialog
      ref={dialog}
      size="sm"
      padded={false}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={(event) => {
        if (!event.currentTarget.open) onDismiss();
      }}
    >
      <div className={styles.artwork} aria-hidden="true">
        <span className={styles.coral} />
        <span className={styles.spectrum} />
        <pre className={`${styles.ascii} ${styles.left}`}>{cloudCharacters}</pre>
        <pre className={`${styles.ascii} ${styles.right}`}>{cloudCharacters}</pre>
        <span className={styles.wordmark}>Tidy</span>
      </div>
      <Button
        type="button"
        className={styles.close}
        aria-label="Close invitation"
        onClick={() => dialog.current?.close()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 6 12 12M6 18 18 6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </Button>
      <div className={styles.copy}>
        <h2 id={`${id}-title`}>Enjoying Tidy?</h2>
        <p id={`${id}-description`}>
          A star helps more people find Tidy and supports what we’re building.
        </p>
      </div>
      <div className={styles.actions}>
        <Button
          ref={dismiss}
          type="button"
          className={styles.dismiss}
          onClick={() => dialog.current?.close()}
        >
          Dismiss
        </Button>
        <a
          className={styles.star}
          href="https://github.com/tidydesigns/tidy"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => dialog.current?.close()}
          onAuxClick={(event) => {
            if (event.button === 1) dialog.current?.close();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          Star on GitHub<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </Dialog>
  );
}
