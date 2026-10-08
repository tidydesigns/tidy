import { fileVersionAtLeast } from "./file-version";

// Version the renderer in the existing column so opaque previews can refresh
// without editing the document or introducing a schema migration.
const format = "png-v2:";
export const thumbnailVersion = (version: string) => `${format}${version}`;
export const thumbnailFileVersion = (version: string | null | undefined) =>
  version?.startsWith(format) ? version.slice(format.length) : "";
export const thumbnailIsCurrent = (thumbnail: string | null | undefined, document: string) => {
  const version = thumbnailFileVersion(thumbnail);
  return Boolean(version) && fileVersionAtLeast(version, document);
};
