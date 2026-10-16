import { fileVersionAtLeast } from "./file-version";

// Version the renderer in the existing column so opaque previews can refresh
// without editing the document or introducing a schema migration.
const format = "png-v2:";
export const thumbnailVersion = (version: string) => `${format}${version}`;
export const thumbnailFileVersion = (version: string | null | undefined) =>
  version?.startsWith(format) ? version.slice(format.length) : "";
// Document revisions describe pixels; file timestamps also change on metadata edits.
// Legacy shapes have no revision, so their timestamp remains part of freshness.
function documentRevision(version: string) {
  const separator = version.indexOf(":");
  const prefix = version.slice(0, separator);
  const revision = Number(prefix);
  return /^\d+$/.test(prefix) &&
    Number.isSafeInteger(revision) &&
    Number.isFinite(Date.parse(version.slice(separator + 1)))
    ? revision
    : null;
}
export function thumbnailFileVersionIsCurrent(current: string, requested: string) {
  if (!current || !requested) return false;
  const revision = documentRevision(current);
  const target = documentRevision(requested);
  if (revision !== null && target !== null) return revision === target;
  return current === requested;
}
/** A newer locally rendered revision must survive stale list metadata. */
export function thumbnailFileVersionAtLeast(current: string, requested: string) {
  if (!current || !requested) return false;
  const revision = documentRevision(current);
  const target = documentRevision(requested);
  if (revision !== null && target !== null) return revision >= target;
  return fileVersionAtLeast(current, requested);
}
export const thumbnailIsCurrent = (thumbnail: string | null | undefined, document: string) =>
  thumbnailFileVersionIsCurrent(thumbnailFileVersion(thumbnail), document);
