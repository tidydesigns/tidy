export const THEME_STORAGE_KEY = "tidy-theme";

export type ThemePreference = "system" | "light" | "dark";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
