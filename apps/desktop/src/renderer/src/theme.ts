export type ThemePreference = "system" | "light" | "dark";

const storageKey = "tidy:theme";
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function currentThemePreference(): ThemePreference {
  return preference;
}

function applyTheme() {
  if (preference === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  preference = readPreference();
  applyTheme();
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
