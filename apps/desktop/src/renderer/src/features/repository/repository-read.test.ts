import { expect, spyOn, test } from "bun:test";
import { repositoryRead } from "./repository-read";

test("repository reads release stalled consumers with a retryable deadline", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    timer.mockImplementationOnce(((callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    }) as typeof setTimeout);
    await expect(repositoryRead(new Promise<never>(() => {}))).rejects.toThrow(
      "This file took too long to open. Try again.",
    );
    expect(await repositoryRead(Promise.resolve("recovered"))).toBe("recovered");
  } finally {
    timer.mockRestore();
  }
});
