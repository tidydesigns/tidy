import { expect, test } from "bun:test";
import { RemoteHarnessUpdates } from "./remote-harness-updates";
import type { RemoteClient } from "../remote/client";
import type { HarnessUpdateState } from "../../shared/contracts/harness-updates";
import { isRemoteMutation } from "../../shared/remote";

test("maintenance discovery polls do not allocate durable mutation receipts", () => {
  expect(isRemoteMutation("backend-harness-update-state")).toBe(false);
  expect(isRemoteMutation("backend-install-harness-update")).toBe(true);
});

const available: HarnessUpdateState[] = [
  {
    id: "codex",
    status: "available",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    canInstall: true,
  },
];

test("attached maintenance sends only the provider ID to the authoritative backend", async () => {
  const calls: { name: string; input: unknown }[] = [];
  let state = available;
  const client = {
    status: { kind: "connected", capabilities: ["harness-updates"] },
    async operation(name: string, input: unknown) {
      calls.push({ name, input });
      if (name === "backend-install-harness-update")
        state = [{ ...available[0], status: "queued", waitReason: "turn" }];
      return structuredClone(state);
    },
  } as unknown as RemoteClient;
  const updates = new RemoteHarnessUpdates(client);
  try {
    await updates.check();
    expect(updates.state).toEqual(available);
    await updates.install("codex");
    expect(calls.find((call) => call.name === "backend-install-harness-update")).toEqual({
      name: "backend-install-harness-update",
      input: "codex",
    });
    expect(updates.busy).toBe(true);
    expect(updates.installing).toBe(false);
  } finally {
    await updates.close();
  }
  expect(
    calls.every((call) =>
      ["backend-harness-update-state", "backend-install-harness-update"].includes(call.name),
    ),
  ).toBe(true);
});

test("disconnecting during a maintenance read cannot publish a stale snapshot or cancel an accepted installer", async () => {
  const response = Promise.withResolvers<HarnessUpdateState[]>();
  const calls: string[] = [];
  const client = {
    status: { kind: "connected", capabilities: ["harness-updates"] },
    operation(name: string) {
      calls.push(name);
      return response.promise;
    },
  } as unknown as RemoteClient;
  const updates = new RemoteHarnessUpdates(client);
  let notifications = 0;
  updates.subscribe(() => {
    notifications++;
  });
  const read = updates.check();
  expect(updates.check()).toBe(read);
  await updates.close();
  response.resolve(available);
  await read;
  expect(notifications).toBe(0);
  expect(updates.state).toEqual([]);
  expect(calls).toEqual(["backend-harness-update-state"]);
  await expect(updates.install("codex")).rejects.toThrow("closing");
});

test("a failed remote discovery preserves the last actionable update", async () => {
  let failed = false;
  const client = {
    status: { kind: "connected", capabilities: ["harness-updates"] },
    async operation() {
      if (failed) throw new Error("Disconnected");
      return structuredClone(available);
    },
  } as unknown as RemoteClient;
  const updates = new RemoteHarnessUpdates(client);
  try {
    await updates.check();
    failed = true;
    await updates.check();
    expect(updates.state).toEqual(available);
  } finally {
    await updates.close();
  }
});
