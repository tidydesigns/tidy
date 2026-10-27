import { expect, test } from "bun:test";
import { machineConnections } from "./machine-connections";

test("concurrent connections share normalized targets and release failed attempts for retry", async () => {
  const targets: string[] = [];
  let finish = () => {};
  const connect = machineConnections(async (target) => {
    targets.push(target);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const first = connect(" user@home ");
  expect(connect("user@home")).toBe(first);
  expect(targets).toEqual(["user@home"]);
  finish();
  await first;
  const next = connect("user@home");
  expect(next).not.toBe(first);
  finish();
  await next;
  let calls = 0;
  const retry = machineConnections(async () => {
    if (++calls === 1) throw new Error("setup failed");
  });
  await expect(retry("home")).rejects.toThrow("setup failed");
  await retry("home");
  expect(calls).toBe(2);
});
