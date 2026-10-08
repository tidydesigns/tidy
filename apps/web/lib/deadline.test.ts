import { expect, test } from "bun:test";
import { withDeadline } from "./deadline";

test("a never-settling dependency has a bounded wait", async () => {
  await expect(
    withDeadline(new Promise<never>(() => {}), 10, "Dependency timed out"),
  ).rejects.toThrow("Dependency timed out");
});

test("deadlines preserve successful results and original errors", async () => {
  expect(await withDeadline(Promise.resolve(42), 1000, "Timed out")).toBe(42);
  const error = new Error("Dependency failed");
  await expect(withDeadline(Promise.reject(error), 1000, "Timed out")).rejects.toBe(error);
});
