import { expect, test } from "bun:test";
import { HarnessDiscovery } from "./harness-discovery";
import type { HarnessConnection } from "../../shared/contracts/desktop";

test("workspace snapshots never wait for agent probes and concurrent probes are shared", async () => {
  const gate = Promise.withResolvers<HarnessConnection[]>();
  let calls = 0;
  const discovery = new HarnessDiscovery(() => {
    calls++;
    return gate.promise;
  });
  expect(discovery.snapshot()).toEqual([]);
  const pending = discovery.refresh();
  expect(discovery.refresh()).toBe(pending);
  expect(discovery.snapshot()).toEqual([]);
  await Promise.resolve();
  expect(calls).toBe(1);
  const ready: HarnessConnection[] = [{ id: "codex", name: "Codex", status: "ready" }];
  gate.resolve(ready);
  await pending;
  expect(discovery.snapshot()).toBe(ready);
  expect(calls).toBe(1);
});

test("failed refreshes preserve the last result and can be retried", async () => {
  let fail = false;
  const ready: HarnessConnection[] = [{ id: "codex", name: "Codex", status: "ready" }];
  const discovery = new HarnessDiscovery(async () => {
    if (fail) throw new Error("probe failed");
    return ready;
  });
  await discovery.refresh();
  fail = true;
  await expect(discovery.refresh()).rejects.toThrow("probe failed");
  expect(discovery.snapshot()).toBe(ready);
  fail = false;
  expect(await discovery.refresh()).toBe(ready);
});
