import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MachineProfiles } from "./profiles";
import { discoverSshHosts } from "./ssh";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "profiles-"));
  roots.push(root);
  return root;
}
test("saved machines retain identity and reject replacement after app restart", async () => {
  const root = await fixture();
  const path = join(root, "machines.json");
  const profiles = new MachineProfiles(path);
  await profiles.initialize();
  const machine = await profiles.remember("user@home");
  const hostId = randomUUID();
  await profiles.connected(machine.id, hostId);
  const restored = new MachineProfiles(path);
  await restored.initialize();
  expect(await restored.remember("user@home")).toMatchObject({ id: machine.id, hostId });
  await expect(restored.connected(machine.id, randomUUID())).rejects.toThrow("identity changed");
  expect(await readFile(path, "utf8")).not.toContain("token");
  await restored.forget(machine.id);
  expect(restored.list()).toEqual([]);
});
test("SSH discovery includes literal hosts and excludes patterns and hashed known hosts", async () => {
  const root = await fixture();
  await mkdir(join(root, "conf.d"));
  await writeFile(join(root, "config"), "Host home *.private !excluded\nInclude conf.d/*\n");
  await writeFile(join(root, "conf.d", "dev"), "Host work\n HostName ignored.example\n");
  await writeFile(
    join(root, "known_hosts"),
    "known ssh-ed25519 sample\n|1|hashed|entry ssh-ed25519 sample\n",
  );
  expect(await discoverSshHosts(root)).toEqual([
    { alias: "home" },
    { alias: "known" },
    { alias: "work" },
  ]);
});

test("open remote windows persist across app restarts and explicit closure disables restoration", async () => {
  const path = join(await fixture(), "machines.json");
  const profiles = new MachineProfiles(path);
  await profiles.initialize();
  const machine = await profiles.remember("user@home");
  await profiles.setOpen(machine.id, true);
  const reopened = new MachineProfiles(path);
  await reopened.initialize();
  expect(reopened.list()[0]?.restoreOnLaunch).toBe(true);
  await reopened.setOpen(machine.id, false);
  await reopened.flush();
  const closed = new MachineProfiles(path);
  await closed.initialize();
  expect(closed.list()[0]?.restoreOnLaunch).toBe(false);
});

test("removing a profile during connection setup rejects its late open reservation", async () => {
  const path = join(await fixture(), "machines.json");
  const profiles = new MachineProfiles(path);
  await profiles.initialize();
  const pending = profiles.remember("user@home");
  const machine = profiles.list()[0];
  await profiles.forget(machine.id);
  expect((await pending).id).toBe(machine.id);
  await expect(profiles.setOpen(machine.id, true)).rejects.toThrow("connection was removed");
  const restored = new MachineProfiles(path);
  await restored.initialize();
  expect(restored.list()).toEqual([]);
});
