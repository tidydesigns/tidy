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
      <picture>
        {eager && enabled && (
          <source
            media={theme === "system" ? "(prefers-color-scheme: dark)" : undefined}
            srcSet={sourceSet(theme === "light" ? light : dark)}
            sizes={sizes}
          />
        )}
        {/* Prebuilt exports support static hosting without a runtime image service. */}
        <img
          src={(selected ?? (eager && enabled ? light : undefined))?.files.at(-1)!.src}
          srcSet={selected ? sourceSet(selected) : eager && enabled ? sourceSet(light) : undefined}
          sizes={sizes}
          width={light.width}
          height={light.height}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          style={{ visibility: selected || (eager && enabled) ? undefined : "hidden" }}
        />
      </picture>
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
            loading={eager ? "eager" : "lazy"}
            decoding="async"
          />
        </picture>
      </noscript>
    </>
  );
}
