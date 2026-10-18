/** Browser-safe retry handling. Keep the caller's operation ID and payload stable. */
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 1000;
  const input = value.trim();
  const numeric = /^\d+$/.test(input);
  const delay = numeric ? Number(input) * 1000 : Date.parse(input) - now;
  if (!numeric && delay > 86_400_000) return 1000;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(250, Math.min(delay, 86_400_000)) : 1000;
}

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Request canceled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchWithRateLimitRetry(
  send: () => Promise<Response>,
  signal: AbortSignal,
  wait: typeof waitForRetry = waitForRetry,
): Promise<Response> {
  for (;;) {
    signal.throwIfAborted();
    const response = await send();
    if (response.status !== 429) return response;
    const delay = retryAfterMilliseconds(response.headers.get("Retry-After"));
    await response.body?.cancel();
    // Jitter spreads clients waking at the same counter boundary. Pending edits
    // remain in the caller's queue and retain navigation/unload protection.
    await wait(delay + Math.floor(Math.random() * 250), signal);
  }
}
