export const repositoryUrl =
  process.env.NEXT_PUBLIC_REPOSITORY_URL || "https://github.com/tidydesigns/tidy";
export const appUrl = new URL(
  "/login",
  process.env.NEXT_PUBLIC_APP_URL || "https://app.tidydesign.co",
).href;
export { downloadUrl } from "./download-url";
export const documentationUrl = `${repositoryUrl}#local-development`;
