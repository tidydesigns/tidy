import { expect, test } from "bun:test";
import { ImageCapacityError, withImageReadCapacity } from "./image-capacity";

test("image work has no waiting queue, nests within one slot and releases failed slots", async () => {
  let release!: () => void,
    entered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: 4 }, () =>
    withImageReadCapacity(async () => {
      entered++;
      await withImageReadCapacity(async () => {
        await gate;
      });
    }),
  );
  try {
    expect(entered).toBe(4);
    let called = false;
    await expect(
      withImageReadCapacity(async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(ImageCapacityError);
    expect(called).toBe(false);
  } finally {
    release();
    await Promise.all(pending);
  }
  await expect(
    withImageReadCapacity(async () => {
      throw new Error("read failure");
    }),
  ).rejects.toThrow("read failure");
  expect(await withImageReadCapacity(async () => "recovered")).toBe("recovered");
});
