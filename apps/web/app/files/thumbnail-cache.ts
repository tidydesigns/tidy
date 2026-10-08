import { fileVersionAtLeast } from "@/lib/design/file-version";

export type CachedThumbnail = { version: string; blob: Blob; persisted: boolean };
const previews = new Map<string, CachedThumbnail>();
let bytes = 0;
const key = (scope: string, fileId: string) => JSON.stringify([scope, fileId]);
export function cachedThumbnail(scope: string | undefined, fileId: string) {
  if (!scope) return;
  const id = key(scope, fileId),
    value = previews.get(id);
  if (value) {
    previews.delete(id);
    previews.set(id, value);
  }
  return value;
}
export function cacheThumbnail(scope: string | undefined, fileId: string, value: CachedThumbnail) {
  if (!scope || value.blob.size > 8_000_000) return;
  const id = key(scope, fileId),
    previous = previews.get(id);
  if (previous && !fileVersionAtLeast(value.version, previous.version)) return;
  if (previous) bytes -= previous.blob.size;
  previews.delete(id);
  previews.set(id, value);
  bytes += value.blob.size;
  while (previews.size > 64 || bytes > 8_000_000) {
    const oldest = previews.keys().next().value!;
    bytes -= previews.get(oldest)!.blob.size;
    previews.delete(oldest);
  }
}
export function clearThumbnailCache() {
  previews.clear();
  bytes = 0;
}
export function removeCachedThumbnail(scope: string | undefined, fileId: string) {
  if (!scope) return;
  const id = key(scope, fileId),
    value = previews.get(id);
  if (value) {
    bytes -= value.blob.size;
    previews.delete(id);
  }
}
