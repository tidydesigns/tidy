import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
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
  async workspace(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid cloud workspace key.");
    const path = join(this.directory, `workspace-${key}`);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid cloud workspace directory.");
    return path;
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
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}
