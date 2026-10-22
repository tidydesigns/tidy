/** Desktop tokens are audience-bound separately from coding-agent tokens. */
export const DESKTOP_SYNC_SCOPE = "desktop:sync";
export function desktopSyncResource(baseURL: string) {
  return new URL("/api/desktop", baseURL).href;
}
