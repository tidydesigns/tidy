import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshFailure } from "./errors";
import { bootstrapScript, prepareHost, reconnectScript } from "./bootstrap";
import { type SshSession, shellQuote } from "./ssh";
import { installHostScript } from "./install-host";
import { ptyPackages } from "../terminal/pty-packages";

const roots: string[] = [];
const releaseOwners: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releaseOwners.splice(0)) await release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const fixtureHostId = randomUUID();
const fixtureInstanceId = randomUUID();
const clientId = randomUUID();
const bundle = Buffer.from(`
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const buildId = createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
process.stdout.write(JSON.stringify({ protocol: 3, buildId, sourceTimestamp: 1,
  capabilities: ['reconnect'], reconnectOnly: process.argv.includes('--reconnect'),
  hostId: '${fixtureHostId}', instanceId: '${fixtureInstanceId}',
  pid: process.pid, port: 12345, managed: true, clientId: process.argv[3],
  token: '${"a".repeat(64)}', updatePending: false }) + '\\n');
`);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "tidy-installer-"));
  roots.push(home);
  const runtime = join(home, ".local/share/tidy/runtime");
  const state = join(home, ".local/state/tidy-host");
  await mkdir(state, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const directories = { runtime, state };
  const target = `${process.platform}-${process.arch}`;
  const checksum = runtimeCases.find((entry) => entry[2] === target)?.[3];
  if (!checksum) throw new Error("Unsupported installer test platform.");
  const sharedName = `node-v24.22.1-${target}`;
  const installed = join(runtime, digest(bundle));
  const environment = { ...process.env, HOME: home, TMPDIR: "/unavailable-temp" };
  async function install(value = bundle) {
    const directory = join(runtime, digest(value));
    await mkdir(join(directory, "bin"), { recursive: true });
    await symlink(node, join(directory, "bin/node"));
    await writeFile(join(directory, "tidy-host.mjs"), value);
    await writeFile(join(directory, "complete"), digest(value) + "\n");
    return directory;
  }
  // Exercise staging and verification with local archives; installer tests never use the network.
  const archives: Record<string, { path: string; checksum: string }> = {};
  for (const [name, contents] of [
    [
      "node-pty",
      "module.exports = require('@lydell/node-pty-' + process.platform + '-' + process.arch);",
    ],
    [`node-pty-${target}`, "module.exports = { fixture: true };"],
  ]) {
    const directory = join(home, name!, "package");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.js"), contents!);
    const archive = join(home, name! + ".tgz");
    execFileSync("tar", ["-czf", archive, "-C", join(home, name!), "package"]);
    archives[name!] = { path: archive, checksum: digest(await readFile(archive)) };
  }
  const prepareScript = (script: string) => {
    for (const [name, archive] of Object.entries(archives))
      script = script.replaceAll(
        ptyPackages[name as keyof typeof ptyPackages].sha256,
        archive.checksum,
      );
    return script;
  };
  const ptyDownload = `
for argument do
  case "$argument" in
    https://registry.npmjs.org/@lydell/node-pty/-/*) archive=${shellQuote(archives["node-pty"]!.path)};;
    https://registry.npmjs.org/@lydell/node-pty-${target}/-/*) archive=${shellQuote(archives[`node-pty-${target}`]!.path)};;
  esac
  destination="$argument"
done
if [ -n "\${archive:-}" ]; then cp "$archive" "$destination"; exit; fi
`;
  const bin = join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "curl"), "#!/bin/sh\n" + ptyDownload + "exit 1\n", { mode: 0o700 });
  const run = (script: string, input?: Buffer) =>
    spawnSync("/bin/sh", ["-c", prepareScript(script)], {
      input,
      env: environment,
      encoding: "utf8",
      timeout: 5000,
    });
  const reconnect = (options: Partial<Parameters<typeof reconnectScript>[0]> = {}) =>
    run(reconnectScript({ buildId: digest(bundle), clientId, directories, ...options }));
  async function sharedNode() {
    const directory = join(runtime, sharedName);
    await mkdir(join(directory, "bin"), { recursive: true });
    await symlink(node, join(directory, "bin/node"));
    await writeFile(join(directory, "complete"), checksum + "\n");
    return directory;
  }
  async function ownHost(legacy = false) {
    const owner = spawn(
      node,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import {lockHost, lockWorkspaceHost} from './src/main/remote/host-lock.ts';
      import {join} from 'node:path';
      const release = process.argv[2] === 'legacy'
        ? lockHost(join(process.argv[1], 'host.lock'))
        : await lockWorkspaceHost(process.argv[1]);
      process.once('SIGTERM', () => { release(); process.exit(0); });
      global.gc();
      process.stdout.write('owned');
      setInterval(() => {}, 1000);
    `,
        state,
        legacy ? "legacy" : "current",
      ],
      {
        cwd: new URL("../../..", import.meta.url),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errors = "";
    owner.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const exited = new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", () => resolve());
    });
    const release = async () => {
      owner.kill("SIGKILL");
      await exited;
    };
    releaseOwners.push(release);
    await Promise.race([
      new Promise<void>((resolve) => owner.stdout.once("data", () => resolve())),
      exited.then(() => {
        throw new Error("Ownership fixture exited: " + errors);
      }),
    ]);
    return release;
  }
  return {
    home,
    runtime,
    state,
    installed,
    directories,
    environment,
    run,
    reconnect,
    install,
    sharedNode,
    sharedName,
    checksum,
    ownHost,
    prepareScript,
    ptyDownload,
    archives,
  };
}

const script = bootstrapScript({ bundle: Buffer.from("fixture"), clientId: randomUUID() });
const preflight = script.slice(0, script.indexOf("\nroot="));
const runtimeCases = [
  [
    "Linux",
    "x86_64",
    "linux-x64",
    "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
  ],
  [
    "Linux",
    "aarch64",
    "linux-arm64",
    "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
  ],
  [
    "Darwin",
    "x86_64",
    "darwin-x64",
    "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
  ],
  [
    "Darwin",
    "arm64",
    "darwin-arm64",
    "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  ],
] as const;
for (const [os, cpu, runtime, hash] of runtimeCases) {
  test(`remote installer selects the verified ${runtime} runtime`, () => {
    const result = spawnSync("/bin/sh", [], {
      input: `uname() { if [ "$1" = "-s" ]; then echo '${os}'; else echo '${cpu}'; fi; }\n${preflight}\nprintf '%s %s' "$platform-$arch" "$checksum"`,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${runtime} ${hash}`);
  });
}
test("unsupported remote systems fail before any installation changes", () => {
  const result = spawnSync("/bin/sh", [], {
    input: `uname() { echo Windows_NT; }\n${preflight}`,
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("separate installer");
  expect(sshFailure(result.stderr).kind).toBe("setup");
});

test("SSH network failures remain retryable while current and older installer errors block", () => {
  for (const message of ["Connection refused", "Connection timed out", "Network is unreachable"])
    expect(sshFailure(message).kind).toBe("unavailable");
  for (const message of [
    "Automatic setup currently supports macOS and Linux",
    "This operating system needs a separate installer.",
  ])
    expect(sshFailure(message).kind).toBe("setup");
});

test("storage failures explain the affected resource while temporary contention remains retryable", () => {
  const failure = sshFailure(
    "TIDY_PHASE:checking\\nTIDY_PHASE:installing\\n/bin/sh: cannot create temp file for here-document: Disk quota exceeded",
  );
  expect(failure.kind).toBe("setup");
  expect(failure.message).toContain("temporary files");
  expect(failure.message).not.toContain("TIDY_PHASE");
  expect(sshFailure("mkdir: cannot create directory: Permission denied").kind).toBe("setup");
  expect(sshFailure("user@host: Permission denied (publickey,password)").kind).toBe(
    "authentication",
  );
  expect(sshFailure("Another installation is still running. Retry shortly.").kind).toBe(
    "unavailable",
  );
  expect(sshFailure("Remote backend recovery failed: ETIMEDOUT").kind).toBe("unavailable");
});

test("reconnect reuses the running verified backend despite a changed desktop bundle and held install lock", async () => {
  const f = await fixture();
  await f.install();
  await writeFile(join(f.runtime, "install.lock"), String(process.pid));
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: digest(bundle),
      hostId: fixtureHostId,
    }),
  );
  const result = f.reconnect({ buildId: "b".repeat(64), expectedHostId: fixtureHostId });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).buildId).toBe(digest(bundle));
  expect((await readdir(f.runtime)).sort()).toEqual([digest(bundle), "install.lock"].sort());
  expect(result.stderr).not.toContain("installing");
});

test("desktop-owned hosts reconnect through a verified helper installed for a different build", async () => {
  const f = await fixture();
  await f.install();
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: "d".repeat(64),
      hostId: fixtureHostId,
      managed: false,
    }),
  );
  const result = f.reconnect({ expectedHostId: fixtureHostId });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).clientId).toBe(clientId);
  expect(JSON.parse(result.stdout).reconnectOnly).toBe(true);
  expect(result.stderr).not.toContain("installing");
});

test("source-launched managed hosts use only helpers that advertise reconnect without maintenance", async () => {
  const f = await fixture();
  const legacy = Buffer.from(
    bundle.toString().replace("capabilities: ['reconnect']", "capabilities: []"),
  );
  const legacyDirectory = await f.install(legacy);
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: "d".repeat(64),
      hostId: fixtureHostId,
      managed: true,
    }),
  );
  expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
  await f.install();
  const result = f.reconnect({ buildId: "c".repeat(64) });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).reconnectOnly).toBe(true);
  expect(await readFile(join(legacyDirectory, "tidy-host.mjs"))).toEqual(legacy);
});

test("installing a helper alongside a live desktop preserves reconnect mode unless updating explicitly", async () => {
  for (const update of [false, true]) {
    const f = await fixture();
    await f.sharedNode();
    await f.ownHost();
    await writeFile(
      join(f.state, "runtime.json"),
      JSON.stringify({
        pid: process.pid,
        protocol: 3,
        buildId: digest(bundle),
        hostId: fixtureHostId,
        managed: false,
      }),
    );
    const result = f.run(
      bootstrapScript({ bundle, clientId, directories: f.directories, update }),
      bundle,
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).reconnectOnly).toBe(!update);
  }
});

test("a healthy host reconnects despite a damaged activation record, which still blocks explicit updates", async () => {
  const f = await fixture();
  await f.install();
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: digest(bundle),
      hostId: fixtureHostId,
      managed: true,
    }),
  );
  await writeFile(join(f.state, "activation.json"), "{damaged");
  const result = f.reconnect({ expectedHostId: fixtureHostId });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).buildId).toBe(digest(bundle));
  expect(f.reconnect({ update: true }).status).not.toBe(0);
});

test("stopped hosts restart their verified accepted activation without installing", async () => {
  const f = await fixture();
  await f.install();
  await writeFile(join(f.state, "activation.json"), JSON.stringify({ buildId: digest(bundle) }));
  const result = f.reconnect({ buildId: "b".repeat(64) });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).buildId).toBe(digest(bundle));
});

test("missing installations explicitly request installation without creating remote state", async () => {
  const f = await fixture();
  expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
  expect(await readdir(f.runtime)).toEqual([]);
  expect(await readdir(f.state)).toEqual([]);
});

test("identity, malformed state, and incompatible live protocols fail without installation fallback", async () => {
  for (const runtime of [
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: digest(bundle),
      hostId: randomUUID(),
    }),
    "{broken",
    JSON.stringify({
      pid: process.pid,
      protocol: 2,
      buildId: digest(bundle),
      hostId: fixtureHostId,
    }),
  ]) {
    const f = await fixture();
    await f.install();
    await f.ownHost();
    await writeFile(join(f.state, "runtime.json"), runtime);
    const result = f.reconnect({ expectedHostId: fixtureHostId });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("TIDY_INSTALL_REQUIRED");
    expect(sshFailure(result.stderr).kind).not.toBe("unavailable");
  }
});

test("damaged owned installations cannot be executed or replaced even when their backend is unresponsive", async () => {
  for (const damage of ["bundle", "marker", "node", "permission"]) {
    const f = await fixture();
    await f.sharedNode();
    await f.install();
    await f.ownHost();
    await writeFile(
      join(f.state, "runtime.json"),
      JSON.stringify({ pid: process.pid, protocol: 3, buildId: digest(bundle) }),
    );
    if (damage === "node" || damage === "permission") {
      await rm(join(f.installed, "bin/node"));
      if (damage === "permission")
        await writeFile(join(f.installed, "bin/node"), "disabled", { mode: 0o600 });
    } else
      await writeFile(
        join(f.installed, damage === "bundle" ? "tidy-host.mjs" : "complete"),
        "damaged",
      );
    const result = f.reconnect();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("TIDY_INSTALL_REQUIRED");
    const install = f.run(
      bootstrapScript({ bundle, clientId, directories: f.directories }),
      bundle,
    );
    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("installation is damaged");
  }
});

test("a reused PID cannot block repair of an inactive installation", async () => {
  const f = await fixture();
  await f.sharedNode();
  await f.install();
  await writeFile(join(f.installed, "complete"), "damaged");
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: digest(bundle),
      hostId: fixtureHostId,
    }),
  );
  expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
  const result = f.run(bootstrapScript({ bundle, clientId, directories: f.directories }), bundle);
  expect(result.status).toBe(0);
  expect(await readFile(join(f.installed, "complete"), "utf8")).toBe(digest(bundle) + "\n");
});

test("an inactive installation with a stale incompatible runtime can request recovery", async () => {
  const f = await fixture();
  await f.sharedNode();
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 2,
      buildId: digest(bundle),
      hostId: fixtureHostId,
    }),
  );
  expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
});

test("inactive bundle and shared runtimes with lost execute permission are repairable", async () => {
  for (const shared of [false, true]) {
    const f = await fixture();
    const sharedDirectory = await f.sharedNode();
    await f.install();
    if (shared) {
      await rm(join(f.installed, "bin/node"));
      await symlink(join(sharedDirectory, "bin/node"), join(f.installed, "bin/node"));
    }
    const executable = join(shared ? sharedDirectory : f.installed, "bin/node");
    await rm(executable);
    await writeFile(executable, "disabled", { mode: 0o600 });
    expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
    async function repair() {
      const stage = await mkdtemp(join(f.runtime, ".stage-"));
      await writeFile(join(stage, "tidy-host.mjs"), bundle);
      let nodeStage = "";
      if (shared) {
        nodeStage = await mkdtemp(join(f.runtime, ".node-stage-"));
        await mkdir(join(nodeStage, "bin"));
        await symlink(node, join(nodeStage, "bin/node"));
        await writeFile(join(nodeStage, "complete"), f.checksum + "\n");
      }
      return spawnSync(
        node,
        [
          "-e",
          installHostScript,
          f.runtime,
          stage,
          nodeStage,
          sharedDirectory,
          f.checksum,
          digest(bundle),
          f.state,
        ],
        { encoding: "utf8", env: f.environment },
      );
    }
    const release = await f.ownHost();
    const blocked = await repair();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("damaged");
    expect(await readFile(executable, "utf8")).toBe("disabled");
    await release();
    const result = await repair();
    expect(result.stderr).not.toContain("EACCES");
    expect(result.status).toBe(0);
    expect(JSON.parse(f.reconnect().stdout).buildId).toBe(digest(bundle));
  }
});

test("inaccessible state directories fail without replacing cached runtimes", async () => {
  const f = await fixture();
  await f.sharedNode();
  await f.install();
  await writeFile(join(f.installed, "complete"), "damaged");
  await chmod(f.state, 0o000);
  try {
    const result = f.reconnect();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EACCES");
    const install = f.run(
      bootstrapScript({ bundle, clientId, directories: f.directories }),
      bundle,
    );
    expect(install.status).not.toBe(0);
    expect(await readFile(join(f.installed, "complete"), "utf8")).toBe("damaged");
  } finally {
    await chmod(f.state, 0o700);
  }
});

test("legacy backend ownership also protects damaged installations", async () => {
  const f = await fixture();
  await f.sharedNode();
  await f.install();
  await f.ownHost(true);
  await writeFile(join(f.installed, "complete"), "damaged");
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: digest(bundle),
    }),
  );
  const recovery = f.reconnect();
  expect({
    status: recovery.status,
    stdout: recovery.stdout,
    stderr: recovery.stderr,
  }).toMatchObject({ status: 1 });
  expect(recovery.stderr).toContain("running backend installation is damaged");
  const result = f.run(bootstrapScript({ bundle, clientId, directories: f.directories }), bundle);
  expect(result.status).not.toBe(0);
  expect(await readFile(join(f.installed, "complete"), "utf8")).toBe("damaged");
});

test("repair cannot trust a stale build record while another backend owns the state", async () => {
  const f = await fixture();
  await f.sharedNode();
  await f.install();
  await f.ownHost();
  await writeFile(join(f.installed, "complete"), "damaged");
  await writeFile(
    join(f.state, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      protocol: 3,
      buildId: "b".repeat(64),
    }),
  );
  const result = f.run(bootstrapScript({ bundle, clientId, directories: f.directories }), bundle);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Stop the backend before repairing this cache");
  expect(await readFile(join(f.installed, "complete"), "utf8")).toBe("damaged");
});

test("backend installation streams bytes into home storage and shares Node across builds", async () => {
  const f = await fixture();
  await f.sharedNode();
  for (const value of [bundle, Buffer.concat([bundle, Buffer.from("\n;")])]) {
    const script = bootstrapScript({ bundle: value, clientId, directories: f.directories });
    expect(script).not.toContain("<<");
    expect(script).not.toContain(value.toString("base64"));
    const result = f.run(script, value);
    expect(result.stderr).not.toContain("checksum mismatch");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).buildId).toBe(digest(value));
    expect(await readFile(join(f.runtime, digest(value), "tidy-host.mjs"))).toEqual(value);
  }
  expect((await readdir(f.runtime)).filter((name) => name.startsWith("node-"))).toEqual([
    f.sharedName,
  ]);
  expect((await readdir(f.runtime)).some((name) => name.startsWith("."))).toBe(false);
});

test("truncated transfers fail checksum validation and remove only their own staging files", async () => {
  const f = await fixture();
  await writeFile(join(f.runtime, "keep.txt"), "user data");
  const result = f.run(
    bootstrapScript({ bundle, clientId, directories: f.directories }),
    bundle.subarray(0, 30),
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Backend checksum mismatch");
  expect(await readdir(f.runtime)).toEqual(["keep.txt"]);
});

test("explicit updates validate identity before requesting an installation", async () => {
  const f = await fixture();
  await f.sharedNode();
  await writeFile(join(f.state, "identity"), fixtureHostId);
  expect(f.reconnect({ update: true, expectedHostId: fixtureHostId }).stdout.trim()).toBe(
    "TIDY_INSTALL_REQUIRED",
  );
  const result = f.reconnect({ update: true, expectedHostId: randomUUID() });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("identity changed");
});

test("prepareHost uploads only after an explicit installation response and propagates other failures", async () => {
  const f = await fixture();
  const bundlePath = join(f.home, "desktop-bundle");
  await writeFile(bundlePath, bundle);
  for (const response of ["host", "install", "invalid", "failure"]) {
    const calls: Parameters<SshSession["execute"]>[0][] = [];
    const host = {
      protocol: 3,
      buildId: "a".repeat(64),
      hostId: fixtureHostId,
      instanceId: fixtureInstanceId,
      pid: 1,
      port: 1234,
      managed: true,
      token: "a".repeat(64),
      clientId,
    };
    const operation = prepareHost({
      bundlePath,
      clientId,
      signal: AbortSignal.timeout(5000),
      progress: () => {},
      ssh: {
        execute: async (input) => {
          calls.push(input);
          if (calls.length === 2) return JSON.stringify(host);
          if (response === "failure") throw new Error("SSH authentication failed");
          return response === "install"
            ? "TIDY_INSTALL_REQUIRED\n"
            : response === "invalid"
              ? "garbage"
              : JSON.stringify(host);
        },
      },
    });
    if (response === "failure" || response === "invalid") await expect(operation).rejects.toThrow();
    else expect((await operation).hostId).toBe(fixtureHostId);
    expect(calls).toHaveLength(response === "install" ? 2 : 1);
    expect(calls[0].input).toBeUndefined();
    if (response === "install") expect(calls[1].input).toEqual(bundle);
  }
});

test("shell quoting preserves binary upload command text", () => {
  const text = "quote ' and $HOME and `uname`\nnext line";
  const result = spawnSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(text)}`], {
    encoding: "utf8",
  });
  expect(result.stdout).toBe(text);
});

test("recovery skips unusable Node candidates and unsupported system Node", async () => {
  const f = await fixture();
  const broken = join(f.runtime, "node-broken/bin");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await f.install();
  expect(JSON.parse(f.reconnect().stdout).buildId).toBe(digest(bundle));
  await rm(f.installed, { recursive: true });
  const bin = join(f.home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
});

test("stopped damaged backends are repaired without deleting other installations", async () => {
  const f = await fixture();
  await f.sharedNode();
  await f.install();
  await writeFile(join(f.installed, "tidy-host.mjs"), "truncated");
  await writeFile(join(f.state, "activation.json"), JSON.stringify({ buildId: digest(bundle) }));
  await writeFile(join(f.runtime, "keep.txt"), "user data");
  expect(f.reconnect().stdout.trim()).toBe("TIDY_INSTALL_REQUIRED");
  const result = f.run(bootstrapScript({ bundle, clientId, directories: f.directories }), bundle);
  expect(result.status).toBe(0);
  expect(await readFile(join(f.installed, "tidy-host.mjs"))).toEqual(bundle);
  expect(await readFile(join(f.runtime, "keep.txt"), "utf8")).toBe("user data");
  expect((await readdir(f.runtime)).some((name) => name.includes("damaged"))).toBe(false);
});

test("source ordering offers updates only when the desktop can replace the remote build", async () => {
  const f = await fixture();
  const bundlePath = join(f.home, "desktop-bundle");
  await writeFile(bundlePath, bundle);
  await writeFile(
    bundlePath + ".json",
    JSON.stringify({ buildId: digest(bundle), sourceTimestamp: 2 }),
  );
  for (const managed of [true, false])
    for (const sourceTimestamp of [1, 2, 3, undefined]) {
      const host = {
        protocol: 3,
        buildId: "b".repeat(64),
        sourceTimestamp,
        hostId: fixtureHostId,
        instanceId: fixtureInstanceId,
        pid: 1,
        port: 1234,
        managed,
        token: "a".repeat(64),
        clientId,
      };
      const result = await prepareHost({
        bundlePath,
        clientId,
        signal: AbortSignal.timeout(5000),
        progress: () => {},
        ssh: { execute: async () => JSON.stringify(host) },
      });
      expect(result.updatePending).toBe(
        managed && (sourceTimestamp === undefined || sourceTimestamp < 2),
      );
    }
});

test("an interrupted installer releases its OS lock for a waiting retry", async () => {
  const f = await fixture();
  await f.sharedNode();
  const owner = spawn(
    node,
    [
      "-e",
      `const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); setInterval(() => {}, 1000);`,
      join(f.runtime, "install-v2.lock"),
    ],
    { stdio: "pipe" },
  );
  owner.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    owner.stdout.once("data", () => resolve());
    owner.once("error", reject);
  });
  const child = spawn(
    "/bin/sh",
    ["-c", f.prepareScript(bootstrapScript({ bundle, clientId, directories: f.directories }))],
    { env: f.environment, stdio: "pipe" },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.resume();
  child.stdin.end(bundle);
  try {
    const code = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(output).toBe("");
    owner.kill("SIGKILL");
    expect(await code).toBe(0);
    expect(JSON.parse(output).buildId).toBe(digest(bundle));
  } finally {
    owner.kill("SIGKILL");
    child.kill("SIGKILL");
  }
});

test("archive checksum failures leave no published runtime or abandoned staging directories", async () => {
  const f = await fixture();
  const bin = join(f.home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "curl"),
    '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do shift; done\nprintf broken > "$1"\n',
    { mode: 0o700 },
  );
  const result = f.run(bootstrapScript({ bundle, clientId, directories: f.directories }), bundle);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Node runtime checksum mismatch");
  expect(await readdir(f.runtime)).toEqual([]);
});

test("PTY package and native binary checksum failures leave the shared runtime intact", async () => {
  for (const binary of [false, true]) {
    const f = await fixture();
    const shared = await f.sharedNode();
    const broken = join(f.home, "broken.tgz");
    await writeFile(broken, "corrupt archive");
    const name = binary ? `node-pty-${process.platform}-${process.arch}` : "node-pty";
    await writeFile(
      join(f.home, ".local/bin/curl"),
      "#!/bin/sh\n" + f.ptyDownload.replace(shellQuote(f.archives[name]!.path), shellQuote(broken)),
      { mode: 0o700 },
    );
    const result = f.run(bootstrapScript({ bundle, clientId, directories: f.directories }), bundle);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      binary ? "PTY binary checksum mismatch" : "PTY package checksum mismatch",
    );
    expect(await readdir(f.runtime)).toEqual([f.sharedName]);
    expect(await readFile(join(shared, "complete"), "utf8")).toBe(f.checksum + "\n");
  }
});

test("a cold verified archive publishes a reusable shared runtime without temporary disk access", async () => {
  const f = await fixture();
  const archiveRoot = join(f.home, f.sharedName);
  await mkdir(join(archiveRoot, "bin"), { recursive: true });
  await writeFile(join(archiveRoot, "LICENSE"), "Fixture runtime");
  await writeFile(
    join(archiveRoot, "bin/node"),
    `#!/bin/sh\nif [ "$1" = --version ]; then printf 'v24.22.1\\n'; else exec ${shellQuote(node)} "$@"; fi\n`,
    { mode: 0o700 },
  );
  const archive = join(f.home, "runtime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", f.home, f.sharedName]);
  const checksum = digest(await readFile(archive));
  const bin = join(f.home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh\n${f.ptyDownload}\nwhile [ "$#" -gt 1 ]; do shift; done\ncp ${shellQuote(archive)} "$1"\nprintf download >> ${shellQuote(join(f.home, "downloads"))}\n`,
    { mode: 0o700 },
  );
  for (const value of [bundle, Buffer.concat([bundle, Buffer.from("\n;")])]) {
    const script = bootstrapScript({ bundle: value, clientId, directories: f.directories }).replace(
      f.checksum,
      checksum,
    );
    const result = f.run(script, value);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).buildId).toBe(digest(value));
    const installedPty = join(f.runtime, digest(value), "node_modules/@lydell/node-pty");
    expect(
      execFileSync(
        node,
        ["-e", "process.stdout.write(String(require(process.argv[1]).fixture))", installedPty],
        { encoding: "utf8" },
      ),
    ).toBe("true");
    expect(await readFile(join(f.runtime, f.sharedName, "complete"), "utf8")).toBe(checksum + "\n");
    expect(result.stderr).toContain("TIDY_PHASE:installing\n");
  }
  expect(await readFile(join(f.home, "downloads"), "utf8")).toBe("download");
});
