import { expect, test } from "bun:test";
import { acquireLeaseWithCleanup } from "./connection-budget";

test("a timed-out acquisition releases a late success but leaves denied duplicate leases intact", async () => {
  for (const acquired of [true, false]) {
    const controller = new AbortController();
    let finish!: (allowed: boolean) => void;
    const releases: string[] = [];
    const background: Promise<unknown>[] = [];
    const guard = {
      acquireConnection: () => new Promise<boolean>((resolve) => (finish = resolve)),
      releaseConnection: async (owner: string, id: string) => {
        releases.push(`${owner}:${id}`);
      },
    };
    const pending = acquireLeaseWithCleanup(
      guard,
      "owner",
      "ticket",
      1000,
      controller.signal,
      (task) => background.push(task),
    ).catch((error: unknown) => error);
    controller.abort(new Error("Timed out"));
    expect(await pending).toBe(controller.signal.reason);
    expect(releases).toEqual([]);
    finish(acquired);
    await Promise.all(background);
    expect(releases).toEqual(acquired ? ["owner:ticket"] : []);
  }
});
