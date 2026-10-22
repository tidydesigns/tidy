import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarnessUpdates } from "./harness-updates";
import {
  parseHarnessVersion,
  newerHarnessVersion,
  maintenanceEnvironment,
  runMaintenance,
  inspectHarnessInstallation,
  latestHarnessVersion,
  harnessInstallCommand,
  type HarnessInstallation,
  type MaintenanceCommand,
} from "./harness-installation";
import type { UpdatableHarnessId } from "../shared/harness-updates";

test("versions compare numerically and unrecognized/prerelease/command text is never installable", () => {
  expect(parseHarnessVersion("codex-cli 0.162.1\n")).toBe("0.162.1");
  expect(parseHarnessVersion("2.1.308 (Claude Code)")).toBe("2.1.308");
  expect(newerHarnessVersion("1.10.0", "1.9.9")).toBe(true);
  expect(newerHarnessVersion("1.9.9", "1.10.0")).toBe(false);
  expect(newerHarnessVersion("1.0.0", "1.0.0")).toBe(false);
  for (const value of [
    "",
    "1.0.0-beta.1",
    "01.0.0",
    "1.2.3; touch /tmp/oops",
    "1.2.3\n1.2.4",
    "99999999999999999999.1.1",
  ])
    expect(() => parseHarnessVersion(value)).toThrow();
});

function discovery(
  executable: string,
  id: UpdatableHarnessId = "codex",
  manager = "npm",
  version = "1.2.3",
) {
  const commands: MaintenanceCommand[] = [];
  const packageName =
    id === "codex"
      ? "@openai/codex"
      : id === "claude"
        ? "@anthropic-ai/claude-code"
        : version.startsWith("2.")
          ? "@opencode/cli"
          : "opencode-ai";
  return {
    commands,
    inspect: () =>
      inspectHarnessInstallation(id, {
        locate: async () => executable,
        find: async (name) => (name === manager || name === "brew" ? `/tools/${name}` : null),
        run: async (command) => {
          commands.push(command);
          if (command.args[0] === "--version") return version;
          if (command.args[0] === "root") return "/global/lib/node_modules";
          if (command.args[0] === "prefix") return "/global";
          throw new Error("Discovery must not invoke an installer.");
        },
        canonical: async (path) => String(path),
        read: async () =>
          Buffer.from(JSON.stringify({ name: packageName, autoUpdatesChannel: "stable" })),
      }),
  };
}

for (const [id, path, action] of [
  ["codex", "/home/user/.codex/packages/standalone/versions/1.2.3/bin/codex", "update"],
  ["claude", "/home/user/.local/share/claude/versions/1.2.3", "update"],
  ["opencode", "/home/user/.opencode/bin/opencode", "upgrade"],
] as const)
  test(`${id} uses its installed native updater`, async () => {
    const { inspect, commands } = discovery(path, id);
    const result = (await inspect())!;
    expect(result.command).toEqual({ executable: path, args: [action] });
    expect(result.channel).toBe(id === "claude" ? "stable" : "latest");
    expect(result.canUpdateWhileRunning).toBe(id === "claude");
    expect(commands).toHaveLength(1);
  });

test("Homebrew uses the exact installed cask/channel rather than migrating installations", async () => {
  const result = (await discovery(
    "/opt/homebrew/Caskroom/claude-code@latest/2.1.308/claude",
    "claude",
  ).inspect())!;
  expect(result.brew).toEqual({ kind: "cask", name: "claude-code@latest" });
  expect(result.command).toEqual({
    executable: "/tools/brew",
    args: ["upgrade", "--cask", "claude-code@latest"],
  });
});

test("npm updates the matching global prefix and pins the advertised version", async () => {
  const { inspect, commands } = discovery("/global/lib/node_modules/@openai/codex/bin/codex.js");
  const result = (await inspect())!;
  expect(harnessInstallCommand(result, "1.3.0")).toEqual({
    executable: "/tools/npm",
    args: [
      "install",
      "--global",
      "@openai/codex@1.3.0",
      "--registry=https://registry.npmjs.org",
      "--prefix",
      "/global",
    ],
  });
  expect(
    commands.every((command) => ["--version", "root", "prefix"].includes(command.args[0])),
  ).toBe(true);
  expect(() => harnessInstallCommand(result, "1.3.0; bad")).toThrow();
});

test("pnpm and Bun preserve their global manager, and package-local installs are not overwritten", async () => {
  const pnpm = (await discovery(
    "/global/lib/node_modules/@openai/codex/bin/codex.js",
    "codex",
    "pnpm",
  ).inspect())!;
  expect(harnessInstallCommand(pnpm, "1.3.0")).toEqual({
    executable: "/tools/pnpm",
    args: ["add", "--global", "@openai/codex@1.3.0", "--registry=https://registry.npmjs.org"],
  });
  const bun = (await discovery(
    `${homedir()}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`,
    "codex",
    "bun",
  ).inspect())!;
  expect(harnessInstallCommand(bun, "1.3.0")).toEqual({
    executable: "/tools/bun",
    args: ["add", "--global", "@openai/codex@1.3.0"],
  });
  expect(
    (await discovery("/project/node_modules/@openai/codex/bin/codex.js").inspect())?.command,
  ).toBeUndefined();
});

test("OpenCode major versions use their own release package", async () => {
  expect(
    (await discovery("/home/user/.opencode/bin/opencode", "opencode", "npm", "1.19.0").inspect())
      ?.packageName,
  ).toBe("opencode-ai");
  expect(
    (await discovery("/home/user/.opencode/bin/opencode", "opencode", "npm", "2.1.0").inspect())
      ?.packageName,
  ).toBe("@opencode/cli");
});

test("metadata discovery is bounded and accepts only a plain stable version from fixed sources", async () => {
  const installation = (await discovery(
    "/home/user/.opencode/bin/opencode",
    "opencode",
  ).inspect())!;
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    return Response.json({
      version: "1.19.4",
      command: "malicious",
      url: "https://example.test/bad",
    });
  }) as typeof fetch;
  expect(await latestHarnessVersion(installation, fetcher)).toBe("1.19.4");
  expect(urls).toEqual(["https://registry.npmjs.org/opencode-ai/latest"]);
  const tooLarge = (async () =>
    new Response(" ".repeat(256 * 1024 + 1))) as unknown as typeof fetch;
  await expect(latestHarnessVersion(installation, tooLarge)).rejects.toThrow("too large");
  const malicious = (async () =>
    Response.json({ version: "1.2.3;bad" })) as unknown as typeof fetch;
  await expect(latestHarnessVersion(installation, malicious)).rejects.toThrow();
  const failed = (async () => new Response(null, { status: 429 })) as unknown as typeof fetch;
  await expect(latestHarnessVersion(installation, failed)).rejects.toThrow();
  const brew: HarnessInstallation = {
    ...installation,
    brew: { kind: "formula", name: "opencode" },
  };
  await latestHarnessVersion(brew, fetcher);
  expect(urls.at(-1)).toBe("https://formulae.brew.sh/api/formula/opencode.json");
});

test("maintenance commands use no inference keys, run outside the project, and time out", async () => {
  expect(maintenanceEnvironment().OPENAI_API_KEY).toBeUndefined();
  expect(maintenanceEnvironment().ANTHROPIC_API_KEY).toBeUndefined();
  const output = await runMaintenance({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
  });
  expect(output).toBe(homedir());
  await expect(
    runMaintenance({ executable: process.execPath, args: ["-e", "setInterval(()=>{}, 1000)"] }, 25),
  ).rejects.toThrow("timed out");
  await expect(runMaintenance({ executable: "/missing/tidy-updater", args: [] })).rejects.toThrow(
    "Could not start",
  );
});

test("one click runs a real fixture updater process and verifies the new CLI version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-maintenance-"));
  const executable = join(directory, ".codex/packages/standalone/current/bin/codex");
  const versionFile = join(directory, "version.txt");
  const invocationFile = join(directory, "invocation.json");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(versionFile, "1.2.3");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('codex-cli ' + fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8')); }
else if (process.argv[2] === 'update') {
  fs.writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2), inferenceKeyPresent:Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)}));
  fs.writeFileSync(${JSON.stringify(versionFile)}, '1.3.0');
} else process.exit(1);
`,
  );
  await chmod(executable, 0o700);
  const updater = new HarnessUpdates({
    reserve: () => () => {},
    inspect: (id) =>
      id === "codex"
        ? inspectHarnessInstallation(id, { locate: async () => executable })
        : Promise.resolve(null),
    latest: async () => "1.3.0",
  });
  try {
    await updater.check();
    expect(await readFile(versionFile, "utf8")).toBe("1.2.3");
    const finished = new Promise<void>((resolve, reject) => {
      const unsubscribe = updater.subscribe((state) => {
        const entry = state.find((entry) => entry.id === "codex");
        if (entry?.status === "updated" || entry?.status === "error") {
          unsubscribe();
          if (entry.status === "updated") resolve();
          else reject(new Error(entry.message));
        }
      });
    });
    updater.install("codex");
    await finished;
    expect(JSON.parse(await readFile(invocationFile, "utf8"))).toEqual({
      cwd: homedir(),
      args: ["update"],
      inferenceKeyPresent: false,
    });
    expect(updater.state[0]).toMatchObject({ status: "updated", installedVersion: "1.3.0" });
  } finally {
    await updater.close();
    await rm(directory, { recursive: true, force: true });
  }
});
