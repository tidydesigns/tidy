import { expect, test } from "bun:test";
import { retryStapler } from "./stapler";

const connectionLost = () =>
  Object.assign(new Error("stapler failed"), {
    code: 68,
    stdout: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
    stderr: "",
  });

test("stapler returns a successful verification without waiting", async () => {
  const waits: number[] = [];
  expect(
    await retryStapler(
      async () => "validated",
      async (ms) => waits.push(ms),
    ),
  ).toBe("validated");
  expect(waits).toEqual([]);
});

test("stapler recovers from Apple connection loss beyond the former three-attempt limit", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryStapler(
    async () => {
      if (++attempts < 6) throw connectionLost();
      return "validated";
    },
    async (ms) => waits.push(ms),
  );
  expect(result).toBe("validated");
  expect(attempts).toBe(6);
  expect(waits).toEqual([5_000, 15_000, 30_000, 60_000, 120_000]);
});

test("stapler propagates the last failure after the bounded retry budget", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const errors = Array.from({ length: 6 }, connectionLost);
  await expect(
    retryStapler(
      async () => {
        throw errors[attempts++];
      },
      async (ms) => waits.push(ms),
    ),
  ).rejects.toBe(errors[5]);
  expect(attempts).toBe(6);
  expect(waits).toEqual([5_000, 15_000, 30_000, 60_000, 120_000]);
});

test("stapler stops retrying when a connection failure becomes a permanent failure", async () => {
  const failure = Object.assign(new Error("No valid ticket"), { code: 65 });
  let attempts = 0;
  const waits: number[] = [];
  await expect(
    retryStapler(
      async () => {
        if (++attempts === 1) throw connectionLost();
        throw failure;
      },
      async (ms) => waits.push(ms),
    ),
  ).rejects.toBe(failure);
  expect(attempts).toBe(2);
  expect(waits).toEqual([5_000]);
});

test.each([
  { code: 65, stdout: "A valid ticket was not found." },
  { code: 68, stdout: "CloudKit returned a permanent error." },
  { code: 68, stdout: "NSURLErrorDomain Code=-1202: untrusted certificate" },
  { code: 1, stdout: "NSURLErrorDomain Code=-1005" },
  { code: "ENOENT", stdout: "" },
])("stapler fails immediately for permanent errors: %j", async (details) => {
  const failure = Object.assign(new Error("stapler failed"), details);
  let attempts = 0;
  const waits: number[] = [];
  await expect(
    retryStapler(
      async () => {
        attempts++;
        throw failure;
      },
      async (ms) => waits.push(ms),
    ),
  ).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(waits).toEqual([]);
});

test("stapler recognizes transient errors written to stderr", async () => {
  let attempts = 0;
  await retryStapler(
    async () => {
      if (++attempts === 1) throw { code: 68, stderr: "NSURLErrorDomain Code=-1001: timed out" };
    },
    async () => {},
  );
  expect(attempts).toBe(2);
});
