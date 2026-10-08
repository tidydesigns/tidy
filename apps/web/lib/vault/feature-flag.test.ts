import { expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";

mock.module("server-only", () => ({}));
const { vaultEnabled } = await import("./feature-flag");
const runtime = { key: "test-key", host: "https://posthog.invalid" };

test("Vault requires an explicit boolean true for the authenticated user", async () => {
  let response: Record<string, boolean | string> = {};
  const requests: Record<string, unknown>[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    if (String(url).includes("/flags")) {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ featureFlags: response });
    }
    return Response.json({ status: 1 });
  }) as typeof fetch);
  try {
    for (const value of [undefined, false, "enabled", true]) {
      response = value === undefined ? {} : { vault: value };
      expect(await vaultEnabled("signed-in-user", runtime)).toBe(value === true);
    }
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.distinct_id).toBe("signed-in-user");
      expect(request.flag_keys_to_evaluate).toEqual(["vault"]);
    }
  } finally {
    transport.mockRestore();
  }
});

test("Vault stays off when PostHog is unavailable or unconfigured", async () => {
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (url) => {
    if (String(url).includes("/flags")) throw new Error("network unavailable");
    return Response.json({ status: 1 });
  }) as typeof fetch);
  try {
    expect(await vaultEnabled("signed-in-user", runtime)).toBe(false);
    transport.mockClear();
    expect(await vaultEnabled("signed-in-user", { key: "" })).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test("every Vault action checks the flag before accessing stored logins", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    let enabled = false;
    const checks = [];
    const writes = [];
    mock.module("server-only", () => ({}));
    mock.module("next/headers", () => ({ headers: async () => new Headers() }));
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "actor" } }) } } }));
    mock.module("@/lib/vault/feature-flag", () => ({ vaultEnabled: async id => { checks.push(id); return enabled; } }));
    mock.module("@/lib/vault/logins", () => ({
      createVaultLogin: async id => { writes.push(id); return { id: "login", name: "Login" }; },
      updateVaultLogin: async id => { writes.push(id); return { id: "login", name: "Login" }; },
      deleteVaultLogin: async id => { writes.push(id); },
    }));
    const { addVaultLogin, editVaultLogin, removeVaultLogin } = await import("./app/vault/actions.ts");
    const run = async () => [await addVaultLogin(new FormData()), await editVaultLogin("login", "name", "Name"), await removeVaultLogin("login")];
    const denied = await run();
    const deniedWrites = writes.length;
    enabled = true;
    const allowed = await run();
    console.log(JSON.stringify({ denied, deniedWrites, allowed, checks, writes }));
  `,
    ],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const result = JSON.parse(child.stdout.toString());
  expect(result.deniedWrites).toBe(0);
  expect(
    result.denied.every((action: { error?: string }) => action.error === "Vault is not available."),
  ).toBe(true);
  expect(result.allowed.every((action: { error?: string }) => !action.error)).toBe(true);
  expect(result.checks).toEqual(Array(6).fill("actor"));
  expect(result.writes).toEqual(Array(3).fill("actor"));
});
