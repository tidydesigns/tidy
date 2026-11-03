"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { MacDownloadButton } from "@/components/workspace/mac-download-button";
import styles from "./preview.module.css";

const studies = [
  {
    id: "cloud-light",
    number: "08",
    name: "Cloud light",
    detail: "A little atmosphere, revealed in the charcoal.",
    motion: "Clouds ease into view · 220 ms",
  },
  {
    id: "spectrum-glint",
    number: "09",
    name: "Spectrum glint",
    detail: "The website’s colour, just along the edge.",
    motion: "A soft spectral reveal · 200 ms",
  },
  {
    id: "prism-edge",
    number: "10",
    name: "Prism edge",
    detail: "A quiet surface with a warmer welcome.",
    motion: "The fine colour edge blooms · 180 ms",
  },
] as const;

export function MacDownloadStudies() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  return (
    <main className={styles.preview} data-preview-theme={theme} style={{ colorScheme: theme }}>
      <header className={styles.header}>
        <span className={styles.wordmark}>Tidy</span>
        <div className={styles.headerActions}>
          <span className={styles.edition}>
            Interaction studies <span>03</span>
          </span>
          <div className={styles.themeControls} role="group" aria-label="Preview appearance">
            {(["light", "dark"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant="text"
                className={styles.themeButton}
                aria-label={`${value === "light" ? "Light" : "Dark"} mode`}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {value === "light" ? "Light" : "Dark"}
              </Button>
            ))}
          </div>
        </div>
      </header>
      <div className={styles.content}>
        <div className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>THE DESKTOP DOWNLOAD</p>
            <h1>A little colour. A quiet interaction.</h1>
          </div>
          <p className={styles.hint}>
            Hover a button to explore.
            <br />
            Or use Tab to focus.
          </p>
        </div>
        <div className={styles.grid}>
          {studies.map((study) => (
            <article className={styles.study} key={study.id} aria-labelledby={`${study.id}-title`}>
              <div className={styles.studyHeader}>
                <h2 id={`${study.id}-title`}>
                  <span>{study.number}</span>
                  {study.name}
                </h2>
                <span className={styles.motion}>{study.motion}</span>
              </div>
              <div className={styles.stage}>
                <div className={styles.sidebarFooter}>
                  <div className={styles.quietRow} aria-hidden="true">
                    <Icon name="comment" size={16} />
                    <span>Send feedback</span>
                  </div>
                  <div className={styles.quietRow} aria-hidden="true">
                    <span className={styles.sparkle}>✧</span>
                    <span>Upgrade to Pro</span>
                  </div>
                  <MacDownloadButton
                    variant={study.id}
                    data-study={study.id}
                    aria-label={`${study.name}: Download for Mac, Beta`}
                    onClick={(event) => event.preventDefault()}
                  />
                </div>
              </div>
              <p className={styles.detail}>{study.detail}</p>
            </article>
          ))}
        </div>
        <footer className={styles.footer}>
          <span>Built from Tidy’s website artwork.</span>
          <span>Still at rest. A little character on hover.</span>
        </footer>
      </div>
    </main>
  );
}
