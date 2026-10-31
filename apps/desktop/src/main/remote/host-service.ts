import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { writePrivateJSON } from "./session-store";
import { persistHostEnvironment } from "./host-environment";

const execute = promisify(execFile);
const marker = "Managed by Tidy remote backend";
type ServiceOptions = {
  directory: string;
  executable: string;
  arguments: string[];
  path: string;
  environment?: NodeJS.ProcessEnv;
};

function unitValue(value: string, expandArguments = false) {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid backend service path.");
  if (expandArguments) value = value.replaceAll("$", "$$");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
}
function xml(value: string) {
  if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("Invalid backend service path.");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function systemdHostUnit(options: ServiceOptions) {
  const logPath = join(options.directory, "server.log");
  if (/[\r\n\0]/.test(logPath)) throw new Error("Invalid backend service path.");
  return `# ${marker}
[Unit]
Description=Tidy remote workspace backend
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${[options.executable, ...options.arguments, "serve", "--managed"].map((value) => unitValue(value, true)).join(" ")}
Environment=${unitValue(`TIDY_HOST_STATE=${options.directory}`)}
Environment=${unitValue(`PATH=${options.path}`)}
Environment=TIDY_HOST_SUPERVISOR=systemd
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=control-group
UMask=0077
StandardOutput=append:${logPath.replaceAll("%", "%%")}
StandardError=inherit

[Install]
WantedBy=default.target
`;
}

export function launchdHostAgent(options: ServiceOptions, label: string) {
  const values = ["/bin/sh", join(options.directory, "launch-host.sh")];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${marker} -->
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${values.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>
<key>TIDY_HOST_STATE</key><string>${xml(options.directory)}</string>
<key>PATH</key><string>${xml(options.path)}</string>
<key>TIDY_HOST_SUPERVISOR</key><string>launchd</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>45</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(options.directory, "server.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.directory, "server.log"))}</string>
</dict></plist>
`;
}

async function installDefinition(path: string, content: string) {
  try {
    const current = await readFile(path, "utf8");
    if (!current.includes(marker))
      throw new Error("An externally managed backend service already exists.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function configured(path: string) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Called only after the shared host/launch locks establish that no backend is running. */
export async function startHostService(
  options: ServiceOptions,
): Promise<"systemd" | "launchd" | null> {
  if (process.env.TIDY_HOST_SERVICE !== "auto") return null;
  const suffix = createHash("sha256").update(options.directory).digest("hex").slice(0, 16);
  if (process.platform === "linux") {
    const name = `tidy-host-${suffix}.service`;
    const path = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "systemd",
      "user",
      name,
    );
    try {
      await execute("systemctl", ["--user", "show-environment"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      if (await configured(path))
        throw new Error(
          "The configured backend service is unavailable. Restore the systemd user manager and reconnect.",
        );
      return null;
    }
    await persistHostEnvironment(options.directory, options.environment ?? process.env);
    await installDefinition(path, systemdHostUnit(options));
    await execute("systemctl", ["--user", "daemon-reload"], {
      timeout: 10_000,
    });
    await execute("systemctl", ["--user", "enable", name], { timeout: 10_000 });
    await execute("systemctl", ["--user", "reset-failed", name], {
      timeout: 10_000,
    });
    // A clean maintenance exit can outpace the manager's stop job. Wait for that job
    // instead of restarting a host that may have recovered and accepted another client.
    for (let attempt = 0; ; attempt++) {
      const state = (
        await execute("systemctl", ["--user", "show", name, "--property=ActiveState", "--value"], {
          timeout: 5000,
        })
      ).stdout.trim();
      if (state === "active" || state === "activating") {
        const pid = Number(
          (
            await execute("systemctl", ["--user", "show", name, "--property=MainPID", "--value"], {
              timeout: 5000,
            })
          ).stdout.trim(),
        );
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return "systemd";
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
      } else if (state !== "deactivating") break;
      if (attempt >= 100)
        throw new Error("The backend service is still shutting down. Retry shortly.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await execute("systemctl", ["--user", "start", name], { timeout: 15_000 });
    return "systemd";
  }
  if (process.platform === "darwin" && process.getuid) {
    const label = `app.tidy.host.${suffix}`;
    const domain = `gui/${process.getuid()}`;
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    try {
      await execute("launchctl", ["print", domain], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      if (await configured(path))
        throw new Error(
          "The configured backend service needs a logged-in macOS user session. Log in and reconnect.",
        );
      return null;
    }
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await installDefinition(
      join(options.directory, "launch-host.sh"),
      `# ${marker}\nexec ${[options.executable, ...options.arguments, "serve", "--managed"].map(quote).join(" ")}\n`,
    );
    await persistHostEnvironment(options.directory, options.environment ?? process.env);
    await installDefinition(path, launchdHostAgent(options, label));
    try {
      await execute("launchctl", ["print", `${domain}/${label}`], {
        timeout: 5000,
      });
    } catch {
      await execute("launchctl", ["bootstrap", domain, path], {
        timeout: 15_000,
      });
      return "launchd";
    }
    // Without -k, kickstart starts a stopped job and leaves a recovered running host alone.
    // The stable launcher picks the selected immutable runtime on its next invocation.
    await execute("launchctl", ["kickstart", `${domain}/${label}`], { timeout: 15_000 });
    return "launchd";
  }
  return null;
}

export function shouldUpdateHost({
  current,
  candidate,
}: {
  current: { buildId: string; sourceTimestamp?: number };
  candidate: { buildId: string; sourceTimestamp: number };
}) {
  if (current.buildId === candidate.buildId) return false;
  // Unknown legacy hosts migrate once; equal/older source builds never replace a newer host.
  return (
    current.sourceTimestamp === undefined || candidate.sourceTimestamp > current.sourceTimestamp
  );
}

const activationSchema = z.object({
  executable: z.string().startsWith("/").min(1),
  arguments: z.array(z.string()).min(1),
  buildId: z.string().min(1),
  sourceTimestamp: z.number().int().nonnegative(),
});

/** The launch lock serializes activation selection across all connecting clients. */
export async function selectHostActivation(
  directory: string,
  candidate: z.infer<typeof activationSchema>,
) {
  const path = join(directory, "activation.json");
  let current: z.infer<typeof activationSchema> | undefined;
  try {
    current = activationSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (current && !shouldUpdateHost({ current, candidate })) return current;
  return activationSchema.parse(candidate);
}

export async function acceptHostActivation(
  directory: string,
  activation: z.infer<typeof activationSchema>,
) {
  await writePrivateJSON(join(directory, "activation.json"), activationSchema.parse(activation), {
    durable: true,
  });
}
