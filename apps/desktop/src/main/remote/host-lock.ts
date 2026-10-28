import { createRequire } from "node:module";
const loadBuiltin = createRequire(import.meta.url);

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
