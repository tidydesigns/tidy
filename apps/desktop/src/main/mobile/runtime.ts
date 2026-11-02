import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrivateScratch } from "../platform/private-scratch";
import { lockBrowserInstall, BrowserInstallBusyError } from "../browser/install-lock";
import { mobileExec } from "./process";

const version = "1.7.8";
const checksum = "44369a2df0b62e3a1764de61bd09280999c7e9b27ea8f20bff1ea3a9db0302a2";
const download = `https://github.com/meta/idb/releases/download/v${version}/idb-companion.macos-arm64.tar.gz`;

export async function mobileCache() {
  let directory = homedir();
  for (const name of [".cache", "tidy", "mobile"]) {
    directory = join(directory, name);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Tidy's mobile cache must be a directory owned by your user, without symlinks.",
      );
  }
  await chmod(directory, 0o700);
  return directory;
}

/** Installed privately, pinned and verified; never invokes Homebrew, sudo or a downloaded shell. */
export class IOSRuntime {
  private pending?: Promise<string>;
  private readonly scratch = new PrivateScratch();
  private readonly lifetime = new AbortController();

  get(progress: (message: string) => void) {
    this.lifetime.signal.throwIfAborted();
    this.pending ??= this.install(progress).catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private async install(progress: (message: string) => void) {
    if (process.env.TIDY_IDB_COMPANION) {
      await access(process.env.TIDY_IDB_COMPANION);
      return process.env.TIDY_IDB_COMPANION;
    }
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error(
        "Interactive iOS previews require an Apple silicon Mac with macOS 15+ and Xcode 26+. Android previews work on other hosts.",
      );
    const cache = await mobileCache();
    const directory = join(cache, `idb-${version}`);
    const executable = join(directory, "idb_companion");
    const installed = async () => {
      try {
        const info = await lstat(directory);
        const binary = await lstat(executable);
        return (
          info.isDirectory() &&
          !info.isSymbolicLink() &&
          binary.isFile() &&
          !binary.isSymbolicLink() &&
          (await readFile(join(directory, ".verified"), "utf8")).trim() === checksum
        );
      } catch {
        return false;
      }
    };
    if (await installed()) return executable;
    let release: (() => void) | undefined;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(180_000)]);
    try {
      while (!release) {
        signal.throwIfAborted();
        try {
          release = lockBrowserInstall(join(cache, "idb-install.lock"));
        } catch (error) {
          if (!(error instanceof BrowserInstallBusyError)) throw error;
          progress("Waiting for iOS preview tools…");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (await installed()) return executable;
      progress("Downloading iOS preview tools…");
      const temporary = await this.scratch.create("tidy-ios-tools-");
      const response = await fetch(download, { signal });
      if (!response.ok || !response.body)
        throw new Error("Could not download iOS preview tools. Check your connection and retry.");
      const chunks: Buffer[] = [];
      let size = 0,
        lastPercent = -1;
      const total = Number(response.headers.get("content-length")) || 31_000_000;
      for await (const value of response.body) {
        size += value.length;
        if (size > 64 * 1024 * 1024)
          throw new Error("The iOS preview tools download exceeded its size limit.");
        chunks.push(Buffer.from(value));
        const percent = Math.min(100, Math.floor((size / total) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          progress(`Preparing iOS preview · ${percent}%`);
        }
      }
      const archive = Buffer.concat(chunks);
      if (createHash("sha256").update(archive).digest("hex") !== checksum)
        throw new Error(
          "The iOS preview tools failed verification. Retry to download a fresh copy.",
        );
      const path = join(temporary, "idb.tar.gz");
      const unpacked = join(temporary, "runtime");
      await writeFile(path, archive, { mode: 0o600 });
      await mkdir(unpacked, { mode: 0o700 });
      await mobileExec("/usr/bin/tar", ["-xzf", path, "-C", unpacked], { signal });
      await chmod(join(unpacked, "idb_companion"), 0o700);
      await writeFile(join(unpacked, ".verified"), checksum, { mode: 0o600 });
      signal.throwIfAborted();
      await rm(directory, { recursive: true, force: true });
      await rename(unpacked, directory);
      return executable;
    } finally {
      release?.();
    }
  }

  async close() {
    this.lifetime.abort();
    await this.pending?.catch(() => {});
    await this.scratch.close();
  }
}
