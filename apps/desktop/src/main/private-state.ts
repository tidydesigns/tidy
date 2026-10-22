import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLocalFile } from "./local-files";

/** Authority and sync baselines live in app data, never in a portable project. */
export class PrivateState {
  constructor(private directory: string) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid private sync directory.");
  }
  private path(key: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(key)) throw new Error("Invalid private state key.");
    return join(this.directory, `${key}.json`);
  }
  async read(key: string): Promise<unknown | undefined> {
    try {
      return JSON.parse((await readLocalFile(this.path(key), 64 * 1024 * 1024)).toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async write(key: string, value: unknown) {
    const path = this.path(key),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}
