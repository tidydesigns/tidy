"use client";

import { Button } from "@tidy/ui/button";
import { useSyncExternalStore } from "react";
import { BrandIcon } from "./brand-icon";
import styles from "./cloud-footer.module.css";

const eventName = "tidy-site-theme";
function snapshot() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function subscribe(callback: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== "tidy-theme") return;
    const theme = event.newValue === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    callback();
  };
  window.addEventListener(eventName, callback);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(eventName, callback);
    window.removeEventListener("storage", storage);
  };
}

export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => "light");
  function choose(mode: "light" | "dark") {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem("tidy-theme", mode);
    } catch {
      /* Theme still changes when storage is unavailable. */
    }
    window.dispatchEvent(new Event(eventName));
  }
  return (
    <div className={styles.themeSwitch} role="group" aria-label="Appearance">
      <Button
        className={styles.themeButton}
        type="button"
        aria-label="Use light theme"
        aria-pressed={theme === "light"}
        onClick={() => choose("light")}
      >
        <BrandIcon name="sun" />
      </Button>
      <Button
        className={styles.themeButton}
        type="button"
        aria-label="Use dark theme"
        aria-pressed={theme === "dark"}
        onClick={() => choose("dark")}
      >
        <BrandIcon name="moon" />
      </Button>
    </div>
  );
}
