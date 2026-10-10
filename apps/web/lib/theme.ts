export const THEME_STORAGE_KEY = "tidy-theme";
const THEME_COOKIE_OPTIONS = "Path=/api/extension; Max-Age=31536000; SameSite=Lax";

export type ThemePreference = "system" | "light" | "dark";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function themeCookie(theme: ThemePreference, secure = false) {
  return `${THEME_STORAGE_KEY}=${theme}; ${THEME_COOKIE_OPTIONS}${secure ? "; Secure" : ""}`;
}

export function themeFromCookies(cookies: string | null): ThemePreference {
  const value =
    cookies
      ?.split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${THEME_STORAGE_KEY}=`))
      ?.slice(THEME_STORAGE_KEY.length + 1) ?? null;
  return isThemePreference(value) ? value : "system";
}

// Runs before first paint, also upgrading existing local-only preferences so
// extension requests receive the same setting without an extra permission.
export const themeInitScript = `var theme="system";try{var stored=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(stored==="light"||stored==="dark"){theme=stored;document.documentElement.dataset.theme=theme}}catch{}try{document.cookie=${JSON.stringify(`${THEME_STORAGE_KEY}=`)}+theme+${JSON.stringify(`; ${THEME_COOKIE_OPTIONS}`)}+(location.protocol==="https:"?"; Secure":"")}catch{}`;
