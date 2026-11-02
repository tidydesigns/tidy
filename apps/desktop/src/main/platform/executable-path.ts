import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Desktop launches may only inherit the system PATH, without user-installed CLIs. */
export function executablePath(path = process.env.PATH, home = homedir()) {
  return [
    ...new Set([
      ...(path ?? "").split(delimiter),
      join(home, ".local/bin"),
      join(home, ".bun/bin"),
      join(home, ".opencode/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ]
    .filter((directory) => isAbsolute(directory))
    .join(delimiter);
}
