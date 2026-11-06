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
    expect(updates.state).toMatchObject(available);
    expect(updates.state[0].checkError).toContain("retry automatically");
  } finally {
    await updates.close();
  }
});

test("a check started before installation cannot replace its queued snapshot", async () => {
  const stale = Promise.withResolvers<HarnessUpdateState[]>();
  const queued: HarnessUpdateState[] = [{ ...available[0], status: "queued", waitReason: "turn" }];
  const updates = new RemoteHarnessUpdates({
    status: { kind: "connected", capabilities: ["harness-updates"] },
    operation(name: string) {
      return name === "backend-harness-update-state" ? stale.promise : Promise.resolve(queued);
    },
  } as unknown as RemoteClient);
  try {
    const checking = updates.check();
    const installing = updates.install("codex");
    await Promise.resolve();
    expect(updates.state).toEqual(queued);
    stale.resolve(available);
    await Promise.all([checking, installing]);
    expect(updates.state).toEqual(queued);
  } finally {
    await updates.close();
  }
});

test("initial backend discovery failure exposes sanitized retryable diagnostics", async () => {
  const updates = new RemoteHarnessUpdates({
    status: { kind: "connected", capabilities: ["harness-updates"] },
    async operation() {
      throw new Error("private credential data");
    },
  } as unknown as RemoteClient);
  try {
    await updates.check();
    expect(updates.state).toHaveLength(3);
    expect(
      updates.state.every((entry) => entry.status === "check-error" && !entry.canInstall),
    ).toBe(true);
    expect(JSON.stringify(updates.state)).not.toContain("credential");
  } finally {
    await updates.close();
  }
});
