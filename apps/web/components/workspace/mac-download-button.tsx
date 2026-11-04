"use client";

import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import posthog from "@/lib/posthog-client";
import { browserConsent } from "@/lib/privacy/consent";
import styles from "./mac-download-button.module.css";

export type MacDownloadVariant = "cloud-light" | "spectrum-glint" | "prism-edge";

const macDownloadUrl = new URL(
  "/download/mac",
  process.env.NEXT_PUBLIC_SITE_URL || "https://tidydesign.co",
).href;

type MacDownloadButtonProps = Omit<ComponentPropsWithoutRef<"a">, "children"> & {
  variant?: MacDownloadVariant;
  /** Only the authenticated sidebar opts in; studies and loading copies stay untracked. */
  analyticsSource?: "web_sidebar";
};

/** Native navigation stays immediate; hover effects remain CSS-only. */
export function MacDownloadButton({
  variant = "cloud-light",
  href = macDownloadUrl,
  className = "",
  analyticsSource,
  onClick,
  onAuxClick,
  ...props
}: MacDownloadButtonProps) {
  function captureDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || !analyticsSource || !browserConsent()?.analytics) return;
    try {
      posthog.capture(
        "desktop_download_clicked",
        { source: analyticsSource, variant, platform: "macos", channel: "beta" },
        { send_instantly: true },
      );
    } catch {
      // Optional analytics must never interrupt the native download link.
    }
  }

  return (
    <a
      data-ph-public
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        captureDownload(event);
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (event.button === 1) captureDownload(event);
      }}
      data-download-variant={variant}
      className={`${styles.button} ${className}`}
    >
      {variant === "cloud-light" ? (
        <span className={styles.atmosphere} aria-hidden="true" />
      ) : (
        <span className={styles.halo} aria-hidden="true" />
      )}
      <svg className={styles.apple} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M16 2c.363 2.179-1.912 3.831-3.184 4.571-.376.219-.799-.059-.734-.489C12.299 4.639 13.094 2 16 2ZM9 6.5c.897 0 1.69.199 2.295.42a3.59 3.59 0 0 0 2.41 0c.604-.221 1.398-.42 2.295-.42 1.085 0 2.465.589 3.5 1.767C16 11 17 15.5 20.269 16.692 19.225 19.559 17.241 21.5 15.5 21.5c-1.5 0-1.5-.7-3-.7s-1.5.7-3 .7C7 21.5 4 17.5 4 12.5c0-4 3-6 5-6Z" />
      </svg>
      <span className={styles.label}>Download for Mac</span>
      <span className={styles.beta}>Beta</span>
      {variant !== "cloud-light" && <span className={styles.edge} aria-hidden="true" />}
    </a>
  );
}
