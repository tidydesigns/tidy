export type Theme = "light" | "dark";

const storageKey = "tidy:theme";
const listeners = new Set<() => void>();
let preference: Theme | null = null;
let systemTheme: MediaQueryList;

function readPreference(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return preference ?? (systemTheme.matches ? "dark" : "light");
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
    if (preference === null) applyTheme();
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

export function selectTheme(theme: Theme): boolean {
  preference = theme;
  applyTheme();
  try {
    localStorage.setItem(storageKey, theme);
    return true;
  } catch {
    return false;
  }
}
