import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { PrivateScratch, scratchRoot, scratchStorageError } from "./private-scratch";
import { BrowserAgentBridge } from "../browser/agent-bridge";
import { BrowserService } from "../browser/browser-service";

test("scratch storage uses platform user caches and ignores shared temporary storage", () => {
  const home = resolve(tmpdir(), "scratch-path-test-home"),
    cache = join(home, "cache");
  assert.equal(
    scratchRoot("linux", { TMPDIR: "/unavailable" }, home),
    join(home, ".cache", "tidy", "host", "tmp"),
  );
  assert.equal(
    scratchRoot("linux", { XDG_CACHE_HOME: cache }, home),
    join(cache, "tidy", "host", "tmp"),
  );
  assert.equal(
    scratchRoot("darwin", {}, home),
    join(home, "Library", "Caches", "tidy", "host", "tmp"),
  );
  assert.equal(
    scratchRoot("win32", { LOCALAPPDATA: cache }, home),
    join(cache, "tidy", "host", "tmp"),
  );
  assert.throws(() => scratchRoot("linux", { XDG_CACHE_HOME: "relative" }), /absolute/);
});

test("scratch directories are private, isolated and cleaned without touching another owner", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "scratch-test-")));
  const root = join(fixture, "tidy", "host", "tmp");
  const first = new PrivateScratch(root),
    second = new PrivateScratch(root);
  try {
    const [a, b] = await Promise.all([first.create("upload-"), second.create("agent-")]);
    assert.notEqual(dirname(a), dirname(b));
    await writeFile(join(a, "private.txt"), "secret", { mode: 0o600 });
    if (process.platform !== "win32") {
      for (const path of [root, dirname(root), dirname(dirname(root)), dirname(a), a])
        assert.equal((await stat(path)).mode & 0o777, 0o700);
    }
    await first.close();
    await assert.rejects(stat(a), { code: "ENOENT" });
    assert.ok((await stat(b)).isDirectory());
    await assert.rejects(first.create("agent-"), /closing/);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("scratch storage refuses symlinked ancestors without writing to their targets", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "scratch-test-")));
  const target = join(fixture, "target");
  const scratch = new PrivateScratch(join(fixture, "tidy", "host", "tmp"));
  try {
    await mkdir(target);
    await symlink(target, join(fixture, "tidy"), "dir");
    await assert.rejects(scratch.create("agent-"), /without symlinks/);
    assert.deepEqual(await readdir(target), []);
  } finally {
    await scratch.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a trusted symlinked cache is supported and close cancels pending allocation", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "scratch-test-")));
  const cache = join(fixture, "cache"),
    alias = join(fixture, "alias");
  const scratch = new PrivateScratch(join(alias, "tidy", "host", "tmp"));
  const closing = new PrivateScratch(join(alias, "tidy", "host", "tmp"));
  try {
    await mkdir(cache);
    await symlink(cache, alias, "dir");
    const directory = await scratch.create("agent-");
    assert.ok(directory.startsWith(cache));
    const pending = closing.create("upload-");
    const rejected = assert.rejects(pending, /closing/);
    await closing.close();
    await rejected;
    assert.deepEqual(await readdir(join(cache, "tidy", "host", "tmp")), [
      dirname(directory).split(/[\\/]/).at(-1),
    ]);
  } finally {
    await Promise.all([scratch.close(), closing.close()]);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("stale cleanup preserves live processes, recent files and unrelated entries", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "scratch-test-")));
  const root = join(fixture, "tidy", "host", "tmp");
  const scratch = new PrivateScratch(root);
  try {
    await mkdir(root, { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const stale = join(root, "process-2147483647-dead");
    const live = join(root, `process-${process.pid}-live`);
    const recent = join(root, "process-2147483647-recent");
    const unrelated = join(root, "unrelated");
    for (const directory of [stale, live, recent, unrelated]) await mkdir(directory);
    for (const directory of [stale, live, unrelated]) await utimes(directory, old, old);
    await scratch.create("agent-");
    await assert.rejects(stat(stale), { code: "ENOENT" });
    for (const directory of [live, recent, unrelated])
      assert.ok((await stat(directory)).isDirectory());
  } finally {
    await scratch.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("storage diagnostics recognize unnamed Linux quota failures and retain the cause", () => {
  for (const error of [
    { code: "ENOSPC" },
    { code: "EDQUOT" },
    { code: "Unknown system error -122", errno: -122 },
  ]) {
    const result = scratchStorageError(error, "/private/cache");
    assert.match(result.message, /quota is full/);
    assert.match(result.message, /\/private\/cache/);
    assert.equal(result.cause, error);
  }
  const permission = Object.assign(new Error("Permission denied"), { code: "EACCES" });
  assert.equal(scratchStorageError(permission, "/cache"), permission);
});

test("browser bridge configuration is private outside shared tmp and revoked on close", async () => {
  const browser = new BrowserService(async () => {});
  const bridge = new BrowserAgentBridge(browser);
  try {
    const session = await bridge.session({ projectId: "project", threadId: "thread" });
    assert.ok(session.configuration.startsWith(await realpath(scratchRoot())));
    assert.match(await readFile(session.configuration, "utf8"), /Authorization: Bearer/);
    if (process.platform !== "win32")
      assert.equal((await stat(session.configuration)).mode & 0o777, 0o600);
    await bridge.close();
    await assert.rejects(stat(session.configuration), { code: "ENOENT" });
  } finally {
    await bridge.close();
    await browser.close();
  }
});
