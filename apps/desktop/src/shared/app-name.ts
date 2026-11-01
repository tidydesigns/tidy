export function isDesktopBeta(version: string) {
  return /^\d+\.\d+\.\d+-beta\.\d+$/.test(version);
}

/** Stable releases and other platforms retain their existing product name. */
export function desktopAppName(version: string, platform: NodeJS.Platform) {
  return platform === "darwin" && isDesktopBeta(version) ? "Tidy (Beta)" : "Tidy";
}

/** Native packaging and development must use the same release-channel artwork. */
export function desktopMacIcon(version: string, format: "icns" | "png") {
  return format === "icns"
    ? isDesktopBeta(version)
      ? "icon-beta.icns"
      : "icon.icns"
    : isDesktopBeta(version)
      ? "icon-macos-beta.png"
      : "icon-macos.png";
}
