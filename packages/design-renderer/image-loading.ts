/** One fetch/recovery sequence and object URL per resolved URL while consumers remain mounted. */
export type ImageLoad =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };
const transient = new Set([429, 502, 503, 504]);
const attempts = 4;
const maxDelay = 30_000;
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
    let response: Response;
    try {
      response = await fetch(source, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        credentials: "same-origin",
      });
    } catch (error) {
      if (signal.aborted || attempt === attempts - 1) throw error;
      await pause(retryDelay(null, attempt), signal);
      continue;
    }
    if (response.ok) {
      try {
        return await response.blob();
      } catch (error) {
        if (signal.aborted || attempt === attempts - 1) throw error;
        await pause(retryDelay(null, attempt), signal);
        continue;
      }
    }
    const delay = retryDelay(response.headers.get("Retry-After"), attempt);
    await response.body?.cancel();
    if (!transient.has(response.status) || attempt === attempts - 1 || delay > maxDelay)
      throw new Error(`Image request failed (${response.status}).`);
    await pause(delay, signal);
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
