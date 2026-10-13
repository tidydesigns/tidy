/** One fetch/recovery sequence and object URL per resolved URL while consumers remain mounted. */
export type ImageLoad =
  | { status: "loading" }
  | { status: "ready"; url: string; width?: number; height?: number }
  | { status: "failed" };
const transient = new Set([429, 502, 503, 504]);
const attempts = 4;
const maxDelay = 30_000;
// A canvas can mount hundreds of distinct images at once. Leave two of the
// server's four read slots for thumbnails/other requests. Queue only in the
// browser; a Worker must never await another request's I/O.
const concurrentRequests = 2;
let activeRequests = 0;
const waiting: (() => void)[] = [];
async function imageRequest<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener("abort", abort);
      activeRequests++;
      resolve();
    };
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason);
    };
    if (activeRequests < concurrentRequests) start();
    else {
      waiting.push(start);
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    signal.throwIfAborted();
    return await work();
  } finally {
    activeRequests--;
    waiting.shift()?.();
  }
}
export function retryDelay(value: string | null, attempt: number, now = Date.now()) {
  const seconds = value === null || value.trim() === "" ? NaN : Number(value);
  const date = value ? Date.parse(value) : NaN;
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(date)
      ? date - now
      : 0;
  // A long server cooldown ends recovery rather than retrying before Retry-After.
  return Math.max(Math.min(500 * 2 ** attempt, 4000), requested, 0);
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function fetchImage(source: string, signal: AbortSignal): Promise<Blob> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let result: Blob | { status: number; delay: number };
    try {
      result = await imageRequest(signal, async () => {
        const response = await fetch(source, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          credentials: "same-origin",
        });
        // Hold the slot until the body is consumed, not just until headers arrive.
        if (response.ok) return await response.blob();
        const delay = retryDelay(response.headers.get("Retry-After"), attempt);
        await response.body?.cancel();
        return { status: response.status, delay };
      });
    } catch (error) {
      if (signal.aborted || attempt === attempts - 1) throw error;
      await pause(retryDelay(null, attempt) + Math.random() * 250, signal);
      continue;
    }
    if (result instanceof Blob) return result;
    if (!transient.has(result.status) || attempt === attempts - 1 || result.delay > maxDelay)
      throw new Error(`Image request failed (${result.status}).`);
    // Release the slot during backoff, and stagger retries from separate tabs.
    await pause(result.delay + Math.random() * 250, signal);
  }
  throw new Error("Image recovery exhausted.");
}
type Entry = {
  state: ImageLoad;
  listeners: Set<(state: ImageLoad) => void>;
  controller: AbortController;
  objectUrl?: string;
  bytes: number;
  pixels: number;
  idleAt: number;
};
export type ImagePool = ReturnType<typeof createImagePool>;
/** Retained images belong to one mounted canvas, never to another file or user.
 * The pixel allowance estimates one RGBA buffer; browser/GPU copies are extra. */
export function createImagePool(retain = false) {
  const entries = new Map<string, Entry>();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const remove = (source: string, entry: Entry) => {
    if (entries.get(source) === entry) entries.delete(source);
    entry.controller.abort();
    if (entry.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(entry.objectUrl);
  };
  const prune = () => {
    clearTimeout(expiry);
    expiry = undefined;
    const idle = [...entries].filter(([, entry]) => !entry.listeners.size);
    let bytes = idle.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    let pixels = idle.reduce((sum, [, entry]) => sum + entry.pixels, 0);
    let count = idle.length;
    const now = Date.now();
    for (const [source, entry] of idle.sort((a, b) => a[1].idleAt - b[1].idleAt)) {
      if (
        count > 32 ||
        bytes > 4 * 1024 * 1024 ||
        pixels > 16 * 1024 * 1024 ||
        now - entry.idleAt >= 30_000
      ) {
        bytes -= entry.bytes;
        pixels -= entry.pixels;
        count--;
        remove(source, entry);
      } else {
        expiry ??= setTimeout(prune, Math.max(1, 30_000 - (now - entry.idleAt)));
      }
    }
  };
  return {
    clear() {
      clearTimeout(expiry);
      expiry = undefined;
      for (const [source, entry] of entries) remove(source, entry);
    },
    subscribe(source: string, listener: (state: ImageLoad) => void) {
      let entry = entries.get(source);
      if (!entry) {
        entry = {
          state: { status: "loading" },
          listeners: new Set(),
          controller: new AbortController(),
          bytes: 0,
          pixels: Infinity,
          idleAt: 0,
        };
        entries.set(source, entry);
        const current = entry;
        void fetchImage(source, current.controller.signal)
          .then(async (blob) => {
            if (current.controller.signal.aborted) return;
            current.bytes = blob.size;
            // Stable small raster URLs let the browser reuse its decoded cache
            // across canvas mounts. Fresh blob URLs otherwise leave distinct native
            // cache entries even after revocation. Keep larger images as blobs.
            if (retain && blob.size <= 256 * 1024 && /^image\/(png|jpeg|webp)$/.test(blob.type)) {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              current.controller.signal.throwIfAborted();
              let binary = "";
              for (let offset = 0; offset < bytes.length; offset += 16_384)
                binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
              current.objectUrl = `data:${blob.type};base64,${btoa(binary)}`;
              current.bytes += current.objectUrl.length * 2;
            } else current.objectUrl = URL.createObjectURL(blob);
            let width: number | undefined, height: number | undefined;
            if (typeof Image !== "undefined") {
              // One decode per shared source, including repeated image fills.
              const image = new Image();
              image.src = current.objectUrl;
              await image.decode();
              width = image.naturalWidth;
              height = image.naturalHeight;
              current.pixels = width * height * 4;
            }
            if (current.controller.signal.aborted) return;
            current.state = { status: "ready", url: current.objectUrl, width, height };
            for (const notify of current.listeners) notify(current.state);
          })
          .catch(() => {
            if (current.controller.signal.aborted) return;
            if (current.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(current.objectUrl);
            current.objectUrl = undefined;
            current.state = { status: "failed" };
            for (const notify of current.listeners) notify(current.state);
          });
      }
      entry.listeners.add(listener);
      const initial = entry;
      if (initial.state.status === "loading") listener(initial.state);
      else
        queueMicrotask(() => {
          if (initial.listeners.has(listener)) listener(initial.state);
        });
      const current = entry;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        current.listeners.delete(listener);
        if (current.listeners.size) return;
        if (retain && current.state.status === "ready" && entries.get(source) === current) {
          current.idleAt = Date.now();
          prune();
        } else remove(source, current);
      };
    },
  };
}
const defaultPool = createImagePool();
export const subscribeImage = defaultPool.subscribe;
