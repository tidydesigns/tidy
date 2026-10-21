import { setTimeout } from "node:timers/promises";

/** Retry only stapler's transient network failures; never bypass ticket verification. */
export async function retryStapler<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const failure = error as { code?: number; stdout?: unknown; stderr?: unknown } | null;
      const output = [failure?.stdout, failure?.stderr]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      // Exit 68 alone also covers permanent CloudKit failures. Require a known
      // URL-loading error: timeout, connection refused/lost, or offline.
      if (
        attempt >= 3 ||
        failure?.code !== 68 ||
        !/NSURLErrorDomain Code=-(?:1001|1004|1005|1009)\b/.test(output)
      )
        throw error;
      const delay = attempt * 5_000;
      console.warn(
        `Apple stapler connection failed; retrying in ${delay / 1_000}s (${attempt + 1}/3).`,
      );
      await wait(delay);
    }
  }
}
