import { thumbnailFileVersion, thumbnailFileVersionAtLeast } from "@/lib/design/thumbnail-version";

export type VersionResponse = {
  versions: Record<string, string>;
  thumbnailVersions?: Record<string, string | null>;
};
export type ThumbnailVersionState = {
  // Null means an authoritative check no longer grants access to this file.
  versions: Record<string, string | null>;
  thumbnailVersions: Record<string, string | null>;
};

export function reconcileThumbnailVersions(
  current: ThumbnailVersionState,
  ids: string[],
  result: VersionResponse,
): ThumbnailVersionState {
  let next = current;
  for (const id of ids) {
    const version = Object.hasOwn(result.versions, id) ? result.versions[id] : null;
    const thumbnail = version ? (result.thumbnailVersions?.[id] ?? null) : null;
    if (current.versions[id] === version && current.thumbnailVersions[id] === thumbnail) continue;
    if (next === current)
      next = {
        versions: { ...current.versions },
        thumbnailVersions: { ...current.thumbnailVersions },
      };
    next.versions[id] = version;
    next.thumbnailVersions[id] = thumbnail;
  }
  return next;
}

export function newestThumbnailVersion(initial: string | null, polled: string | null | undefined) {
  return polled &&
    (!thumbnailFileVersion(initial) ||
      thumbnailFileVersionAtLeast(thumbnailFileVersion(polled), thumbnailFileVersion(initial)))
    ? polled
    : initial;
}
