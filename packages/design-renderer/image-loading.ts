/** One fetch/recovery sequence and object URL per resolved URL while consumers remain mounted. */
export type ImageLoad =
  | { status: "loading" }
  | { status: "ready"; url: string }
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
};
const entries = new Map<string, Entry>();
export function subscribeImage(source: string, listener: (state: ImageLoad) => void) {
  let entry = entries.get(source);
  if (!entry) {
    entry = {
      state: { status: "loading" },
      listeners: new Set(),
      controller: new AbortController(),
    };
    entries.set(source, entry);
    const current = entry;
    void fetchImage(source, current.controller.signal)
      .then((blob) => {
        if (current.controller.signal.aborted) return;
        current.objectUrl = URL.createObjectURL(blob);
        current.state = { status: "ready", url: current.objectUrl };
        for (const notify of current.listeners) notify(current.state);
      })
      .catch(() => {
        if (current.controller.signal.aborted) return;
        current.state = { status: "failed" };
        for (const notify of current.listeners) notify(current.state);
      });
  }
  entry.listeners.add(listener);
  listener(entry.state);
  const current = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.listeners.delete(listener);
    if (current.listeners.size) return;
    entries.delete(source);
    current.controller.abort();
    if (current.objectUrl) URL.revokeObjectURL(current.objectUrl);
  };
}
