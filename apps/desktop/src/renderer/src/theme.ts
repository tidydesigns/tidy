export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const storageKey = "tidy:theme";
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let systemTheme: MediaQueryList;

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function currentTheme(): Theme {
  return preference === "system" ? (systemTheme.matches ? "dark" : "light") : preference;
}

export function currentThemePreference(): ThemePreference {
  return preference;
}

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  preference = readPreference();
  applyTheme();
  systemTheme.addEventListener("change", () => {
    if (preference === "system") applyTheme();
  });
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== storageKey && event.key !== null) return;
    preference = readPreference();
    applyTheme();
  });
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function selectTheme(theme: ThemePreference): boolean {
  preference = theme;
  applyTheme();
  try {
    if (theme === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, theme);
    return true;
  } catch {
    return false;
  }
}
