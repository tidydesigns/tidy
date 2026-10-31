import { chmod, lstat, mkdir, mkdtemp, opendir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const storageFailure = z.object({ code: z.string().optional(), errno: z.number().optional() });
const errorCode = (error: unknown) => storageFailure.safeParse(error).data?.code;

export function scratchRoot(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const cache =
    platform === "win32"
      ? environment.LOCALAPPDATA || join(home, "AppData", "Local")
      : platform === "darwin"
        ? join(home, "Library", "Caches")
        : environment.XDG_CACHE_HOME || join(home, ".cache");
  if (!isAbsolute(cache)) throw new Error("Tidy's cache directory must be an absolute path.");
  return join(cache, "tidy", "host", "tmp");
}

export function scratchStorageError(error: unknown, directory: string): Error {
  const failure = storageFailure.safeParse(error).data;
  if (failure?.code === "ENOSPC" || failure?.code === "EDQUOT" || failure?.errno === -122)
    return new Error(
      `Tidy cannot write temporary files in ${directory}: the disk or user storage quota is full. Free space on this host and try again.`,
      { cause: error },
    );
  return error instanceof Error
    ? error
    : new Error("Tidy could not prepare private storage.", { cause: error });
}

/** Private scratch files stay on the host's user disk, independent of the shared /tmp quota. */
export class PrivateScratch {
  private pending?: Promise<string>;
  private maintenance?: Promise<void>;
  private closing = false;

  constructor(private readonly root = scratchRoot()) {}

  private async initialize() {
    const cache = resolve(this.root, "..", "..", "..");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    let directory = await realpath(cache);
    for (const component of relative(cache, resolve(this.root)).split(sep)) {
      directory = join(directory, component);
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Tidy private storage must be a directory without symlinks: ${directory}`);
      if (process.platform !== "win32" && info.uid !== process.getuid?.())
        throw new Error(`Tidy private storage belongs to another user: ${directory}`);
      await chmod(directory, 0o700);
    }
    const created = await mkdtemp(join(directory, `process-${process.pid}-`));
    this.maintenance = this.removeStale(directory).catch(() => {});
    return created;
  }

  private async removeStale(root: string) {
    let scanned = 0;
    for await (const entry of await opendir(root)) {
      if (++scanned > 256) break;
      const match = /^process-([1-9]\d*)-[a-zA-Z0-9]+$/.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = join(root, entry.name);
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
        if (process.platform !== "win32" && info.uid !== process.getuid?.()) continue;
        try {
          process.kill(Number(match[1]), 0);
          continue;
        } catch (error) {
          if (errorCode(error) !== "ESRCH") continue;
        }
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Another host process may have removed the stale directory.
      }
    }
  }

  async create(prefix: string) {
    if (this.closing) throw new Error("Tidy private storage is closing.");
    if (!/^[a-z-]+$/.test(prefix)) throw new Error("Invalid private storage prefix.");
    try {
      this.pending ??= this.initialize().catch((error: unknown) => {
        this.pending = undefined;
        throw error;
      });
      const directory = await this.pending;
      if (this.closing) throw new Error("Tidy private storage is closing.");
      const created = await mkdtemp(join(directory, prefix));
      if (this.closing) {
        await rm(created, { recursive: true, force: true });
        throw new Error("Tidy private storage is closing.");
      }
      return created;
    } catch (error) {
      throw scratchStorageError(error, this.root);
    }
  }

  async close() {
    this.closing = true;
    const directory = await this.pending?.catch(() => undefined);
    await this.maintenance;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
