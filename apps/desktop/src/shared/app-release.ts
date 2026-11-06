export function isDesktopBeta(version: string) {
  return /^\d+\.\d+\.\d+-beta\.\d+$/.test(version);
}
