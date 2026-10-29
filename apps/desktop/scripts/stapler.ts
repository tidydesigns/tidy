import { setTimeout } from "node:timers/promises";

// Ticket delivery can remain unavailable beyond the first three attempts.
// Allow 230 seconds of backoff without exhausting the release job's time budget.
const retryDelays = [5_000, 15_000, 30_000, 60_000, 120_000];

/** Retry only stapler's transient network failures; never bypass ticket verification. */
export async function retryStapler<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const failure = error as { code?: number; stdout?: unknown; stderr?: unknown } | null;
      const output = [failure?.stdout, failure?.stderr]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      // Exit 68 alone also covers permanent CloudKit failures. Require a known
      // URL-loading error: timeout, connection refused/lost, or offline.
      const delay = retryDelays[attempt];
      if (
        delay === undefined ||
        failure?.code !== 68 ||
        !/NSURLErrorDomain Code=-(?:1001|1004|1005|1009)\b/.test(output)
      )
        throw error;
      console.warn(
        `Apple stapler connection failed; retrying in ${delay / 1_000}s (${attempt + 2}/${retryDelays.length + 1}).`,
      );
      await wait(delay);
    }
  }
}
