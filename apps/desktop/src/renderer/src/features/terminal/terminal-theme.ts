import type { ITheme } from "ghostty-web";
import { currentThemePreference, subscribeTheme } from "../../theme";

// Keep the terminal's default colors aligned with styles/theme.css. ANSI colors
// need separate palettes: the usual bright terminal colors wash out on white.
export const terminalThemes = {
  light: {
    background: "#ffffff",
    foreground: "#292929",
    cursor: "#292929",
    cursorAccent: "#ffffff",
    selectionBackground: "#dedede",
    selectionForeground: "#292929",
    black: "#292929",
    red: "#b91c1c",
    green: "#15803d",
    yellow: "#854d0e",
    blue: "#1d4ed8",
    magenta: "#9333a8",
    cyan: "#0e7490",
    white: "#656565",
    brightBlack: "#656565",
    brightRed: "#c02626",
    brightGreen: "#16743c",
    brightYellow: "#92600a",
    brightBlue: "#2563eb",
    brightMagenta: "#a21caf",
    brightCyan: "#087e8b",
    brightWhite: "#474747",
  },
  dark: {
    background: "#171717",
    foreground: "#ededed",
    cursor: "#ededed",
    cursorAccent: "#171717",
    selectionBackground: "#353535",
    selectionForeground: "#ededed",
    black: "#171717",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#d48de5",
    cyan: "#5ccfe6",
    white: "#d4d4d4",
    brightBlack: "#aaaaaa",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#e9a8f5",
    brightCyan: "#a5f3fc",
    brightWhite: "#fafafa",
  },
} satisfies Record<"light" | "dark", Required<ITheme>>;

export function currentTerminalTheme() {
  const preference = currentThemePreference();
  return terminalThemes[
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference
  ];
}

export function subscribeTerminalTheme(listener: () => void) {
  const stop = subscribeTheme(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const changed = () => {
    if (currentThemePreference() === "system") listener();
  };
  media.addEventListener("change", changed);
  return () => {
    stop();
    media.removeEventListener("change", changed);
  };
}
