import { expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";

mock.module("server-only", () => ({}));
const { vaultEnabled } = await import("./feature-flag");

test("Vault access is independent of optional analytics and sends no user data", async () => {
  const previous = process.env.VAULT_ENABLED;
  const transport = spyOn(globalThis, "fetch");
  try {
    for (const value of [undefined, "0", "true", "1"]) {
      if (value === undefined) delete process.env.VAULT_ENABLED;
      else process.env.VAULT_ENABLED = value;
      expect(await vaultEnabled("signed-in-user")).toBe(value === "1");
    }
    expect(transport).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.VAULT_ENABLED;
    else process.env.VAULT_ENABLED = previous;
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
