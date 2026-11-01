/** Stable releases and other platforms retain their existing product name. */
export function desktopAppName(version: string, platform: NodeJS.Platform) {
  return platform === "darwin" && /^\d+\.\d+\.\d+-beta\.\d+$/.test(version)
    ? "Tidy (Beta)"
    : "Tidy";
}
