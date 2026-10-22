import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import { findExecutable, findHarness, harnessEnvironment } from "./harnesses";
import { readLocalFile } from "./local-files";
import type { UpdatableHarnessId } from "../shared/harness-updates";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Normalize supported CLI version output, rejecting prereleases and unsafe numeric segments. */
export function parseHarnessVersion(output: string) {
  const match = /^(?:codex-cli\s+)?(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?\s*$/.exec(output.trim());
  if (!match || !stableVersion.test(match[1])) throw new Error("Unsupported harness version.");
  if (!match[1].split(".").map(Number).every(Number.isSafeInteger))
    throw new Error("Unsupported harness version.");
  return match[1];
}
/** Compare validated stable versions numerically without treating prereleases as upgrades. */
export function newerHarnessVersion(latest: string, installed: string) {
  const left = parseHarnessVersion(latest).split(".").map(Number);
  const right = parseHarnessVersion(installed).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/** Do not give maintenance commands inference keys or project-specific environment/configuration. */
export function maintenanceEnvironment() {
  const environment = harnessEnvironment();
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"])
    delete environment[key];
  environment.CI = "1";
  environment.HOMEBREW_NO_ENV_HINTS = "1";
  environment.HOMEBREW_NO_INSTALL_CLEANUP = "1";
  environment.DISABLE_AUTOUPDATER = "1";
  environment.OPENCODE_DISABLE_AUTOUPDATE = "1";
  for (const key of ["CLAUDE_CONFIG_DIR", "DISABLE_UPDATES"])
    if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

export type MaintenanceCommand = { executable: string; args: string[] };
/** Bound commands, close stdin, and kill their process group on timeout, including subprocesses. */
export function runMaintenance(command: MaintenanceCommand, timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: homedir(),
      env: maintenanceEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      failed = true;
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 1000);
      force.unref();
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Keep draining verbose package managers without retaining unbounded output.
      output = (output + chunk).slice(-128 * 1024);
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      clearTimeout(force);
      reject(new Error("Could not start the harness updater."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      if (failed) reject(new Error("The harness updater timed out."));
      else if (code !== 0) reject(new Error("The harness updater failed."));
      else resolve(output);
    });
  });
}

export type HarnessInstallation = {
  id: UpdatableHarnessId;
  executable: string;
  version: string;
  packageName: string;
  channel: "latest" | "stable";
  /** Native Claude installs into a versioned directory without replacing a running session. */
  canUpdateWhileRunning?: boolean;
  command?: MaintenanceCommand;
  // Homebrew's channel may intentionally lag behind npm's latest release.
  brew?: { kind: "cask" | "formula"; name: string };
};

/** Discover only existing installations; never install a second copy as an update. */
export async function inspectHarnessInstallation(
  id: UpdatableHarnessId,
  dependencies: {
    locate?: typeof findHarness;
    find?: typeof findExecutable;
    run?: typeof runMaintenance;
    read?: typeof readLocalFile;
    canonical?: (path: string) => Promise<string>;
  } = {},
): Promise<HarnessInstallation | null> {
  const run = dependencies.run ?? runMaintenance;
  const read = dependencies.read ?? readLocalFile;
  const canonical = dependencies.canonical ?? realpath;
  const find = dependencies.find ?? findExecutable;
  const executable = await (dependencies.locate ?? findHarness)(id);
  if (!executable) return null;
  const version = parseHarnessVersion(await run({ executable, args: ["--version"] }));
  const packageName =
    id === "codex"
      ? "@openai/codex"
      : id === "claude"
        ? "@anthropic-ai/claude-code"
        : Number(version.split(".")[0]) >= 2
          ? "@opencode/cli"
          : "opencode-ai";
  const installation: HarnessInstallation = {
    id,
    executable,
    version,
    packageName,
    channel: "latest",
  };
  // Avoid spawning .cmd wrappers through a shell. Native installers still work on Windows.
  if (/\.(?:cmd|bat)$/i.test(executable)) return installation;
  const normalized = executable.split(sep).join("/");
  const brew = /^(.*)\/(Caskroom|Cellar)\/(codex|claude-code(?:@latest)?|opencode)\//.exec(
    normalized,
  );
  if (brew) {
    const expected = id === "claude" ? ["claude-code", "claude-code@latest"] : [id];
    if (!expected.includes(brew[3])) return installation;
    const updater = await find("brew", { PATH: join(brew[1], "bin") });
    if (updater) {
      installation.brew = { kind: brew[2] === "Caskroom" ? "cask" : "formula", name: brew[3] };
      installation.command = {
        executable: updater,
        args: ["upgrade", `--${installation.brew.kind}`, brew[3]],
      };
    }
    return installation;
  }
  if (id === "claude") {
    try {
      const settings = JSON.parse(
        (
          await read(
            join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
            1024 * 1024,
          )
        ).toString("utf8"),
      );
      if (settings.autoUpdatesChannel === "stable") installation.channel = "stable";
    } catch {
      /* Use the CLI's default channel when no settings file exists. */
    }
  }
  const native =
    id === "codex"
      ? normalized.includes("/.codex/packages/standalone/")
      : id === "claude"
        ? normalized.includes("/.local/share/claude/versions/")
        : normalized.endsWith("/.opencode/bin/opencode");
  if (native) {
    installation.command = { executable, args: [id === "opencode" ? "upgrade" : "update"] };
    installation.canUpdateWhileRunning = id === "claude";
    return installation;
  }
  // Match the resolved global root, including version-manager prefixes. A package-local
  // binary or a different manager's global install must never be overwritten by npm.
  for (const manager of ["npm", "pnpm", "bun"] as const) {
    if (!normalized.includes("/node_modules/")) break;
    const updater = await find(manager);
    if (!updater || /\.(?:cmd|bat)$/i.test(updater)) continue;
    try {
      const root =
        manager === "bun"
          ? join(homedir(), ".bun/install/global/node_modules")
          : (await run({ executable: updater, args: ["root", "--global"] })).trim();
      const packageRoot = await canonical(join(root, packageName));
      if (!executable.startsWith(packageRoot + sep)) continue;
      const manifest = z
        .object({ name: z.literal(packageName) })
        .safeParse(
          JSON.parse((await read(join(packageRoot, "package.json"), 64 * 1024)).toString("utf8")),
        );
      if (!manifest.success) continue;
      if (manager === "bun") {
        installation.command = { executable: updater, args: ["add", "--global", packageName] };
      } else {
        const args = [
          manager === "pnpm" ? "add" : "install",
          "--global",
          packageName,
          "--registry=https://registry.npmjs.org",
        ];
        if (manager === "npm") {
          const prefix = (await run({ executable: updater, args: ["prefix", "--global"] })).trim();
          args.push("--prefix", prefix);
        }
        installation.command = { executable: updater, args };
      }
      break;
    } catch {
      /* A missing/mismatched manager is not permission to replace this installation. */
    }
  }
  return installation;
}

/** Fetch bounded version metadata, never executable URLs or commands from a remote response. */
export async function latestHarnessVersion(
  installation: HarnessInstallation,
  fetcher: typeof fetch = fetch,
) {
  const source = installation.brew
    ? `https://formulae.brew.sh/api/${installation.brew.kind}/${installation.brew.name}.json`
    : `https://registry.npmjs.org/${encodeURIComponent(installation.packageName)}/${installation.channel}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher(source, {
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok || !response.body) throw new Error("Could not check harness updates.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 256 * 1024) throw new Error("Harness update metadata is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const metadata = z
      .object({
        version: z.string().optional(),
        versions: z.object({ stable: z.string() }).optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return parseHarnessVersion(metadata.version ?? metadata.versions?.stable ?? "");
  } finally {
    clearTimeout(timer);
  }
}

/** Pin package-manager updates to the version shown to the user. */
export function harnessInstallCommand(
  installation: HarnessInstallation,
  version: string,
): MaintenanceCommand {
  parseHarnessVersion(version);
  if (!installation.command) throw new Error("Update this installation with its package manager.");
  const command = {
    executable: installation.command.executable,
    args: [...installation.command.args],
  };
  const index = command.args.indexOf(installation.packageName);
  if (index >= 0) command.args[index] = `${installation.packageName}@${version}`;
  if (installation.id === "opencode" && command.args[0] === "upgrade" && !installation.brew)
    command.args.push(version);
  return command;
}
