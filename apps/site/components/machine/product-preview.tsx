"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ProductCaptureImage } from "./product-capture";
import styles from "./machine.module.css";

// Keep this query aligned with the mobile layout in machine.module.css.
const mobileQuery = "(max-width: 800px)";
function subscribeViewport(callback: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function mobileSnapshot() {
  return window.matchMedia(mobileQuery).matches;
}
function serverSnapshot() {
  return null;
}

export function ProductPreview() {
  const mobile = useSyncExternalStore(subscribeViewport, mobileSnapshot, serverSnapshot);
  return (
    <figure id="desktop-demo" className={styles.productPreview}>
      <div className={styles.desktopWindow}>
        <div className={styles.desktopStill}>
          <ProductCaptureImage
            product="desktop-initial"
            enabled={mobile === true}
            alt="Tidy for macOS as the sample project opens, with its thread sidebar, conversation and floating design preview."
            sizes="calc(100vw - 48px)"
          />
        </div>
        <InteractiveDesktopPreview />
      </div>
    </figure>
  );
}

/** Load only on wider screens, then retain the iframe so resizing preserves edits. */
function InteractiveDesktopPreview() {
  const windowRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<string>();
  const [ready, setReady] = useState(false);

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
        setReady(true);
        syncTheme();
      }
    };
    window.addEventListener("message", onMessage);
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || window.matchMedia(mobileQuery).matches) return;
        setSource(`/desktop-demo/index.html?theme=${theme()}&scroll=website`);
        observer.disconnect();
      },
      { rootMargin: "300px" },
    );
    if (windowRef.current) observer.observe(windowRef.current);
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return (
    <div ref={windowRef} className={styles.desktopLive}>
      <div className={styles.windowControls} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      {!ready && (
        <div className={styles.desktopLoading} role="status">
          Opening the sample project…
        </div>
      )}
      {source && (
        <iframe
          ref={frameRef}
          className={styles.desktopFrame}
          src={source}
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
      )}
      <p id="desktop-demo-description" className="sr-only">
        Interactive sample project using the real Tidy desktop app. Open the floating design preview
        to edit the canvas, then minimise the canvas to return to the thread. Changes stay in this
        demo until the page reloads. Coding agents are simulated.
      </p>
    </div>
  );
}
