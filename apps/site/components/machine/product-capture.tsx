"use client";

import { useSyncExternalStore } from "react";
import captures from "../../public/product/manifest.json";

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
function snapshot() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function serverSnapshot() {
  return "system";
}

/** A single image: the browser fetches the selected theme and responsive width. */
export function ProductCaptureImage({
  product,
  alt,
  enabled = true,
  eager = false,
  sizes = "(max-width: 760px) calc(100vw - 48px), (max-width: 1264px) calc(100vw - 64px), 1200px",
}: {
  product: "canvas" | "desktop" | "desktop-initial";
  alt: string;
  enabled?: boolean;
  eager?: boolean;
  sizes?: string;
}) {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const light = captures[`${product}-light`];
  const dark = captures[`${product}-dark`];
  const sourceSet = (capture: typeof light) =>
    capture.files.map((file) => `${file.src} ${file.width}w`).join(", ");
  const selected = !enabled || theme === "system" ? undefined : theme === "dark" ? dark : light;
  return (
    <>
      <picture className="product-capture-scripted">
        <source
          data-capture-theme="dark"
          data-fallback={dark.files.at(-1)!.src}
          media={selected === dark ? "all" : "not all"}
          srcSet={sourceSet(dark)}
          sizes={sizes}
          suppressHydrationWarning
        />
        <source
          data-capture-theme="light"
          data-fallback={light.files.at(-1)!.src}
          media={selected === light ? "all" : "not all"}
          srcSet={sourceSet(light)}
          sizes={sizes}
          suppressHydrationWarning
        />
        {/* Prebuilt exports support static hosting without a runtime image service. */}
        <img
          src={selected?.files.at(-1)!.src}
          srcSet={selected ? sourceSet(selected) : undefined}
          sizes={sizes}
          width={light.width}
          height={light.height}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          suppressHydrationWarning
        />
      </picture>
      {enabled && (
        <script
          dangerouslySetInnerHTML={{
            // Resolve the already-initialized site theme while HTML is parsed,
            // before hydration. Inactive sources prevent the preload scanner
            // from downloading the system theme when a saved preference differs.
            __html: `(function(){var p=document.currentScript.previousElementSibling,t=document.documentElement.dataset.theme==='dark'?'dark':'light',s=p.querySelector('[data-capture-theme="'+t+'"]');if(s){s.media='all';p.querySelector('img').src=s.dataset.fallback}})()`,
          }}
        />
      )}
      <noscript>
        <style>{".product-capture-scripted { display: none; }"}</style>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={sourceSet(dark)} sizes={sizes} />
          <img
            src={light.files.at(-1)!.src}
            srcSet={sourceSet(light)}
            sizes={sizes}
            width={light.width}
            height={light.height}
            alt={alt}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
          />
        </picture>
      </noscript>
    </>
  );
}
