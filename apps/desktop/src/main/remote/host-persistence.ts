import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PreparedHost } from "../../shared/remote";

const execute = promisify(execFile);

export async function hostPersistenceWarning(
  supervisor: PreparedHost["supervisor"],
  readLingering = async () => {
    const result = await execute(
      "loginctl",
      ["show-user", String(process.getuid?.()), "--property=Linger", "--value"],
      { timeout: 3000, maxBuffer: 1024 },
    );
    return result.stdout.trim();
  },
): Promise<string | undefined> {
  if (supervisor === "launchd")
    return "The remote backend restarts automatically while its macOS user is logged in. Logging out stops it.";
  if (supervisor !== "systemd")
    return "This host has no available background service manager. Reconnect to start the backend after a crash or reboot.";
  try {
    const lingering = await readLingering();
    if (lingering === "yes") return undefined;
    if (lingering === "no")
      return "The remote backend stops after logout. To keep it running and start it at boot, enable lingering for this user on the remote machine with loginctl enable-linger.";
  } catch {
    // Some remote hosts restrict querying login sessions without restricting user services.
  }
  return "The remote backend is supervised, but persistence after logout could not be verified. Check this user's lingering setting on the remote machine.";
}
