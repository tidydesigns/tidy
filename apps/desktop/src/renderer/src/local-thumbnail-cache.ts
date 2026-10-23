type Thumbnail = { key: string; version: string; blob: Blob; touched: number };
const memory = new Map<string, Thumbnail>();
const maximumBytes = 8_000_000;
let opening: Promise<IDBDatabase> | undefined;
const key = (projectId: string, designId: string) => `${projectId}:${designId}`;

function database() {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("tidy-local-thumbnails", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("previews", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
function remember(value: Thumbnail) {
  memory.delete(value.key);
  memory.set(value.key, value);
  let bytes = [...memory.values()].reduce((total, entry) => total + entry.blob.size, 0);
  while (memory.size > 64 || bytes > maximumBytes) {
    const oldest = memory.keys().next().value!;
    bytes -= memory.get(oldest)!.blob.size;
    memory.delete(oldest);
  }
}
export function cachedLocalThumbnail(projectId: string, designId: string) {
  const value = memory.get(key(projectId, designId));
  if (value) remember(value);
  return value;
}
export async function readLocalThumbnail(projectId: string, designId: string) {
  const cached = cachedLocalThumbnail(projectId, designId);
  if (cached) return cached;
  try {
    const db = await database();
    const value = await new Promise<Thumbnail | undefined>((resolve, reject) => {
      const request = db
        .transaction("previews")
        .objectStore("previews")
        .get(key(projectId, designId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value?.blob instanceof Blob && value.blob.size <= maximumBytes) {
      remember(value);
      return value;
    }
  } catch {
    // Private browsing/storage quotas must not prevent file access or previews.
  }
}
export async function cacheLocalThumbnail(
  projectId: string,
  designId: string,
  version: string,
  blob: Blob,
) {
  if (blob.size > maximumBytes) return;
  const value = { key: key(projectId, designId), version, blob, touched: Date.now() };
  remember(value);
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("previews", "readwrite");
      const store = transaction.objectStore("previews");
      store.put(value);
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = (request.result as Thumbnail[]).sort((a, b) => b.touched - a.touched);
        let bytes = 0;
        entries.forEach((entry, index) => {
          bytes += entry.blob.size;
          if (index >= 64 || bytes > maximumBytes) store.delete(entry.key);
        });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // A displayed raster remains usable even if persistence is unavailable.
  }
}
