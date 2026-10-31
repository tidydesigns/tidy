import { createRequire } from "node:module";
import { join } from "node:path";
import { readLocalFile } from "../platform/local-files";
import { writePrivateJSON } from "./session-store";
const loadBuiltin = createRequire(import.meta.url);

const workspaceLockFormat = { format: "tidy-workspace-lock", version: 2 };
const workspaceLockMarker = JSON.stringify(workspaceLockFormat);

export function lockHost(path: string) {
  const { DatabaseSync }: typeof import("node:sqlite") = loadBuiltin("node:sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch {
    database.close();
    throw new Error("Another Tidy backend is using this state directory.");
  }
  return () => database.close();
}

export async function lockWorkspaceHost(directory: string) {
  const legacyPath = join(directory, "host.lock");
  // Automatic remote setup supports POSIX hosts; retain the Windows ownership protocol.
  if (process.platform === "win32") return lockHost(legacyPath);
  try {
    const contents = (await readLocalFile(legacyPath, 64 * 1024)).toString("utf8");
    if (contents === workspaceLockMarker) return lockHost(join(directory, "host-v2.lock"));
    if (contents.startsWith("{"))
      throw new Error("The backend ownership format requires a newer version of Tidy.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const releaseLegacy = lockHost(legacyPath);
  try {
    const release = lockHost(join(directory, "host-v2.lock"));
    try {
      // Keep both ownership locks until the marker atomically excludes legacy launchers.
      await writePrivateJSON(legacyPath, workspaceLockFormat, { durable: true });
      return release;
    } catch (error) {
      release();
      throw error;
    }
  } finally {
    releaseLegacy();
  }
}
