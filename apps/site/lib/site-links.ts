export const repositoryUrl =
  process.env.NEXT_PUBLIC_REPOSITORY_URL || "https://github.com/tidydesigns/tidy";
export const appUrl = new URL(
  "/login",
  process.env.NEXT_PUBLIC_APP_URL || "https://app.tidydesign.co",
).href;
// Releases include macOS betas, which GitHub's /releases/latest excludes.
export const downloadUrl = process.env.NEXT_PUBLIC_DOWNLOAD_URL || `${repositoryUrl}/releases`;
export const documentationUrl = `${repositoryUrl}#local-development`;
