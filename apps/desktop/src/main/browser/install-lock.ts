import { createRequire } from "node:module";

const loadBuiltin = createRequire(import.meta.url);
export class BrowserInstallBusyError extends Error {}

export function lockBrowserInstall(path: string) {
  const database = (() => {
    if (process.versions.bun) {
      const sqlite: typeof import("bun:sqlite") = loadBuiltin("bun:sqlite");
      return new sqlite.Database(path, { create: true });
    }
    const sqlite: typeof import("node:sqlite") = loadBuiltin("node:sqlite");
    return new sqlite.DatabaseSync(path);
  })();
  try {
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    if (
      error instanceof Error &&
      (("code" in error && error.code === "SQLITE_BUSY") ||
        ("errcode" in error && error.errcode === 5))
    )
      throw new BrowserInstallBusyError("Another process is installing the browser.");
    throw error;
  }
  return () => database.close();
}
