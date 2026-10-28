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
  sizes = "(max-width: 760px) calc(100vw - 48px), (max-width: 1264px) calc(100vw - 64px), 1200px",
}: {
  product: "canvas" | "desktop" | "desktop-initial";
  alt: string;
  enabled?: boolean;
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
      {/* Prebuilt exports support static hosting without a runtime image service. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- Responsive lossless exports are optimized at build time for static hosting. */}
      <img
        src={selected?.files.at(-1)!.src}
        srcSet={selected && sourceSet(selected)}
        sizes={sizes}
        width={light.width}
        height={light.height}
        alt={alt}
        loading="lazy"
        decoding="async"
        style={{ visibility: selected ? undefined : "hidden" }}
      />
      <noscript>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={sourceSet(dark)} sizes={sizes} />
          <img
            src={light.files.at(-1)!.src}
            srcSet={sourceSet(light)}
            sizes={sizes}
            width={light.width}
            height={light.height}
            alt={alt}
            loading="lazy"
            decoding="async"
          />
        </picture>
      </noscript>
    </>
  );
}
