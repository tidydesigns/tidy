import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  launchdHostAgent,
  shouldUpdateHost,
  selectHostActivation,
  acceptHostActivation,
  startHostService,
  systemdHostUnit,
} from "./host-service";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const options = {
  directory: '/home/user/a "quoted" $workspace%/state',
  executable: "/home/user/runtime/bin/node",
  arguments: ["/home/user/runtime/tidy-host.mjs"],
  path: "/home/user/.local/bin:/usr/bin:/bin",
};

test("backend source ordering prevents older clients and equal revisions from replacing a shared host", () => {
  const current = { buildId: "current", sourceTimestamp: 200 };
  expect(
    shouldUpdateHost({
      current,
      candidate: { buildId: "older", sourceTimestamp: 100 },
    }),
  ).toBe(false);
  expect(
    shouldUpdateHost({
      current,
      candidate: { buildId: "different", sourceTimestamp: 200 },
    }),
  ).toBe(false);
  expect(
    shouldUpdateHost({
      current,
      candidate: { buildId: "unversioned", sourceTimestamp: 0 },
    }),
  ).toBe(false);
  expect(
    shouldUpdateHost({
      current,
      candidate: { buildId: "current", sourceTimestamp: 300 },
    }),
  ).toBe(false);
  expect(
    shouldUpdateHost({
      current,
      candidate: { buildId: "newer", sourceTimestamp: 300 },
    }),
  ).toBe(true);
  expect(
    shouldUpdateHost({
      current: { buildId: "legacy" },
      candidate: { buildId: "newer", sourceTimestamp: 300 },
    }),
  ).toBe(true);
});

test("service definitions preserve private loopback host arguments and clean maintenance shutdown", () => {
  const unit = systemdHostUnit(options);
  expect(unit).toContain('"serve" "--managed"');
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("RestartSec=5");
  expect(unit).toContain("KillMode=control-group");
  expect(unit).toContain("UMask=0077");
  expect(unit).toContain(
    'Environment="TIDY_HOST_STATE=/home/user/a \\"quoted\\" $workspace%%/state"',
  );
  const agent = launchdHostAgent(options, "app.tidy.host.fixture");
  expect(agent).toContain("<key>SuccessfulExit</key><false/>");
  expect(agent).toContain("<key>RunAtLoad</key><true/>");
  expect(agent).toContain("<key>ThrottleInterval</key><integer>5</integer>");
  expect(agent).toContain("a &quot;quoted&quot; $workspace%/state");
  expect(() => systemdHostUnit({ ...options, executable: "node\nExecStart=bad" })).toThrow(
    "Invalid backend service path",
  );
});

async function managerFixture({ unavailable = false }: { unavailable?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "host-service-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  cleanup.push(() => {
    process.env = previous;
  });
  const bin = join(root, "bin");
  await mkdir(bin);
  process.env.PATH = bin;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.TIDY_HOST_SERVICE = "auto";
  process.env.TIDY_SERVICE_TEST_LOG = join(root, "calls");
  await writeFile(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TIDY_SERVICE_TEST_LOG"\n${unavailable ? "exit 1" : "exit 0"}\n`,
    { mode: 0o700 },
  );
  const input = { ...options, directory: join(root, "state") };
  const suffix = createHash("sha256").update(input.directory).digest("hex").slice(0, 16);
  const name = `tidy-host-${suffix}.service`;
  const definition = join(process.env.XDG_CONFIG_HOME, "systemd", "user", name);
  return { root, input, name, definition };
}

test.skipIf(process.platform !== "linux")(
  "service setup enables only the per-user unit and never changes linger",
  async () => {
    const fixture = await managerFixture();
    expect(await startHostService(fixture.input)).toBe("systemd");
    expect(await readFile(fixture.definition, "utf8")).toBe(systemdHostUnit(fixture.input));
    expect((await readFile(join(fixture.root, "calls"), "utf8")).trim().split("\n")).toEqual([
      "--user show-environment",
      "--user daemon-reload",
      `--user enable ${fixture.name}`,
      `--user reset-failed ${fixture.name}`,
      `--user show ${fixture.name} --property=ActiveState --value`,
      `--user start ${fixture.name}`,
    ]);
  },
);

test.skipIf(process.platform !== "linux")(
  "unavailable manager falls back only before a service has been configured",
  async () => {
    const fixture = await managerFixture({ unavailable: true });
    expect(await startHostService(fixture.input)).toBeNull();
    await mkdir(join(fixture.root, "config", "systemd", "user"), {
      recursive: true,
    });
    await writeFile(fixture.definition, systemdHostUnit(fixture.input));
    await expect(startHostService(fixture.input)).rejects.toThrow(
      "configured backend service is unavailable",
    );
  },
);

test.skipIf(process.platform !== "linux")(
  "service setup refuses to overwrite an external unit",
  async () => {
    const fixture = await managerFixture();
    await mkdir(join(fixture.root, "config", "systemd", "user"), {
      recursive: true,
    });
    await writeFile(fixture.definition, "external unit");
    await expect(startHostService(fixture.input)).rejects.toThrow("externally managed");
    expect(await readFile(fixture.definition, "utf8")).toBe("external unit");
  },
);

test("persisted activation survives a stopped host without allowing older or equal builds to take over", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-activation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const newer = {
    executable: "/runtime/new/bin/node",
    arguments: ["/runtime/new/host.mjs"],
    buildId: "new",
    sourceTimestamp: 200,
  };
  const older = {
    executable: "/runtime/old/bin/node",
    arguments: ["/runtime/old/host.mjs"],
    buildId: "old",
    sourceTimestamp: 100,
  };
  expect(await selectHostActivation(root, newer)).toEqual(newer);
  await acceptHostActivation(root, newer);
  expect(await selectHostActivation(root, older)).toEqual(newer);
  expect(await selectHostActivation(root, { ...older, sourceTimestamp: 200 })).toEqual(newer);
  await acceptHostActivation(root, older);
  expect(JSON.parse(await readFile(join(root, "activation.json"), "utf8"))).toEqual(newer);
  const latest = { ...older, sourceTimestamp: 300 };
  expect(await selectHostActivation(root, latest)).toEqual(latest);
  expect(JSON.parse(await readFile(join(root, "activation.json"), "utf8"))).toEqual(newer);
  expect(await selectHostActivation(root, older)).toEqual(newer);
  await acceptHostActivation(root, latest);
  expect(await selectHostActivation(root, older)).toEqual(latest);
});

test.skipIf(process.platform !== "linux")(
  "a recovered service is reused without restarting another client's host",
  async () => {
    const fixture = await managerFixture();
    await writeFile(
      join(fixture.root, "bin", "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TIDY_SERVICE_TEST_LOG"
if [ "$2" = show ]; then
  if [ "$4" = --property=MainPID ]; then printf '${process.pid}\\n'; else printf 'active\\n'; fi
fi
`,
      { mode: 0o700 },
    );
    expect(await startHostService(fixture.input)).toBe("systemd");
    const calls = await readFile(join(fixture.root, "calls"), "utf8");
    expect(calls).not.toContain("--user start ");
    expect(calls).not.toContain("--user restart ");
    expect(calls).not.toContain("--user stop ");
  },
);

test.skipIf(process.platform !== "linux")(
  "service activation waits for a clean maintenance stop before starting the selected runtime",
  async () => {
    const fixture = await managerFixture();
    process.env.TIDY_SERVICE_TEST_STOPPED = join(fixture.root, "stopped");
    await writeFile(
      join(fixture.root, "bin", "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TIDY_SERVICE_TEST_LOG"
if [ "$2" = show ]; then
  if [ -f "$TIDY_SERVICE_TEST_STOPPED" ]; then printf 'inactive\\n'; else printf 'deactivating\\n'; printf '' > "$TIDY_SERVICE_TEST_STOPPED"; fi
fi
`,
      { mode: 0o700 },
    );
    expect(await startHostService(fixture.input)).toBe("systemd");
    const calls = (await readFile(join(fixture.root, "calls"), "utf8")).trim().split("\n");
    expect(calls.filter((value) => value.includes("--property=ActiveState"))).toHaveLength(2);
    expect(calls.at(-1)).toBe(`--user start ${fixture.name}`);
  },
);

test.skipIf(process.platform !== "linux")(
  "an active service with no surviving process is allowed to finish stopping before startup",
  async () => {
    const fixture = await managerFixture();
    process.env.TIDY_SERVICE_TEST_STOPPED = join(fixture.root, "stopped");
    await writeFile(
      join(fixture.root, "bin", "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TIDY_SERVICE_TEST_LOG"
if [ "$2" = show ]; then
  if [ "$4" = --property=MainPID ]; then
    printf '0\\n'
    printf '' > "$TIDY_SERVICE_TEST_STOPPED"
  elif [ -f "$TIDY_SERVICE_TEST_STOPPED" ]; then printf 'inactive\\n'; else printf 'active\\n'; fi
fi
`,
      { mode: 0o700 },
    );
    expect(await startHostService(fixture.input)).toBe("systemd");
    const calls = (await readFile(join(fixture.root, "calls"), "utf8")).trim().split("\n");
    expect(calls.filter((value) => value.includes("--property=ActiveState"))).toHaveLength(2);
    expect(calls.at(-1)).toBe(`--user start ${fixture.name}`);
  },
);

const canVerifyUnits =
  process.platform === "linux" && spawnSync("systemd-analyze", ["--version"]).status === 0;
test.skipIf(!canVerifyUnits)(
  "generated unit passes the installed systemd parser including its log path",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "host-unit-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "tidy-host.service");
    await writeFile(
      path,
      systemdHostUnit({
        ...options,
        directory: join(root, "quoted $ path%"),
        executable: process.execPath,
      }),
    );
    const result = spawnSync("systemd-analyze", ["verify", path], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Failed to parse|Unknown|Invalid/);
  },
);
