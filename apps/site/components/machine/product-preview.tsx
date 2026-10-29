"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProductCaptureImage } from "./product-capture";
import styles from "./machine.module.css";

export function ProductPreview() {
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  return (
    <figure id="desktop-demo" className={styles.productPreview}>
      <noscript>
        <style>{`
          .${styles.desktopStill} { display: block; }
          .${styles.desktopLive} { display: none; }
          .${styles.desktopWindow} { height: auto; aspect-ratio: 8 / 5; }
        `}</style>
      </noscript>
      <div className={styles.desktopWindow}>
        <div className={styles.desktopStill} data-ready={ready}>
          <ProductCaptureImage
            product="desktop-initial"
            eager
            alt="Tidy for macOS as the sample project opens, with its thread sidebar, conversation and floating design preview."
            sizes="(max-width: 800px) calc(100vw - 48px), (max-width: 1376px) calc(100vw - 96px), 1280px"
          />
        </div>
        <InteractiveDesktopPreview onReady={onReady} />
      </div>
    </figure>
  );
}

/** The browser starts the demo from the initial HTML, before site hydration. */
function InteractiveDesktopPreview({ onReady }: { onReady(): void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const theme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    const syncTheme = () =>
      frameRef.current?.contentWindow?.postMessage(
        { type: "tidy-demo-theme", theme: theme() },
        location.origin,
      );
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frameRef.current?.contentWindow)
        return;
      if (event.data?.type === "tidy-demo-scroll" && Number.isFinite(event.data.deltaY)) {
        window.scrollBy({ top: event.data.deltaY, behavior: "instant" });
      }
      if (event.data?.type === "tidy-demo-ready") {
        onReady();
        syncTheme();
      }
    };
    window.addEventListener("message", onMessage);
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    // The frame may finish before the site hydrates; request its current state.
    frameRef.current?.contentWindow?.postMessage({ type: "tidy-demo-status" }, location.origin);
    return () => {
      themeObserver.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, [onReady]);

  return (
    <div className={styles.desktopLive}>
      <div className={styles.windowControls} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <iframe
        ref={frameRef}
        className={styles.desktopFrame}
        src="/desktop-demo/index.html?scroll=website"
        loading="eager"
        title="Interactive Tidy desktop app: sample project"
        aria-describedby="desktop-demo-description"
        sandbox="allow-scripts allow-same-origin allow-downloads"
        onLoad={() =>
          frameRef.current?.contentWindow?.postMessage(
            {
              type: "tidy-demo-theme",
              theme: document.documentElement.dataset.theme,
            },
            location.origin,
          )
        }
      />
      <p id="desktop-demo-description" className="sr-only">
        Interactive sample project using the real Tidy desktop app. Open the floating design preview
        to edit the canvas, then minimise the canvas to return to the thread. Changes stay in this
        demo until the page reloads. Coding agents are simulated.
      </p>
    </div>
  );
}
