"use client";

import { useId, useSyncExternalStore } from "react";
import {
  isThemePreference,
  THEME_STORAGE_KEY,
  themeCookie,
  type ThemePreference,
} from "@/lib/theme";
import { SelectMenu } from "./select-menu";

const changeEvent = "tidy-theme-change";
const choices: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
let inMemoryTheme: ThemePreference | null = null;

function currentTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return inMemoryTheme ?? (isThemePreference(value) ? value : "system");
  } catch {
    return inMemoryTheme ?? "system";
  }
}

function subscribe(listener: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    inMemoryTheme = null;
    applyTheme(currentTheme());
    listener();
  }
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

function applyTheme(theme: ThemePreference) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    document.cookie = themeCookie(theme, window.location.protocol === "https:");
  } catch {
    // The app preference still works when cookies are unavailable.
  }
}

function selectTheme(theme: ThemePreference) {
  inMemoryTheme = theme;
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The selection still applies in this tab when storage is unavailable.
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(changeEvent));
}

export function ThemePreferenceControl({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "system");
  const labelId = useId();

  return (
    <div
      className={
        compact
          ? "flex items-center justify-between gap-3 px-3 py-2 text-sm"
          : "text-sm font-medium"
      }
    >
      <span data-ph-public id={labelId}>
        Theme
      </span>
      <SelectMenu
        replayLabel
        replayOptions
        value={theme}
        options={choices}
        label="Theme"
        labelledBy={labelId}
        onChange={(value) => {
          if (isThemePreference(value)) selectTheme(value);
        }}
        className={compact ? "w-32 shrink-0" : "mt-2 w-full max-w-xs"}
        placement={compact ? "top" : "bottom"}
      />
    </div>
  );
}
