import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostEnvironment, loadHostEnvironment, persistHostEnvironment } from "./host-environment";
import { launchdHostAgent, systemdHostUnit } from "./host-service";

const dummyEnvironment = {
  OPENAI_API_KEY: "dummy-openai-credential",
  ANTHROPIC_API_KEY: "dummy-anthropic-credential",
  OPENCODE_API_KEY: "dummy-opencode-credential",
  GEMINI_API_KEY: "dummy-gemini-credential",
  HTTPS_PROXY: "https://dummy:password@proxy.invalid",
  CODEX_HOME: "/dummy/provider-home",
  CLAUDE_CONFIG_DIR: "/dummy/config",
  XDG_CACHE_HOME: "/dummy/cache",
  TIDY_BROWSER_EXECUTABLE: "/dummy/chrome",
  TIDY_BROWSER_SANDBOX: "0",
  TMPDIR: "/unavailable-tmp",
  TMP: "/unavailable-tmp",
  TEMP: "/unavailable-tmp",
  UNRELATED_SECRET: "dummy-unrelated-credential",
  NODE_OPTIONS: "--import /dummy/untrusted-module",
};

test("supervisor snapshots preserve supported credentials and config without inherited temp or arbitrary keys", () => {
  const environment = hostEnvironment(dummyEnvironment);
  for (const [key, value] of Object.entries(dummyEnvironment)) {
    if (!["TMPDIR", "TMP", "TEMP", "UNRELATED_SECRET", "NODE_OPTIONS"].includes(key))
      assert.equal(environment[key], value);
  }
  for (const key of ["TMPDIR", "TMP", "TEMP", "UNRELATED_SECRET", "NODE_OPTIONS"])
    assert.equal(environment[key], undefined);
});

test("supervisor environment survives restart privately and newer snapshots replace old credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-environment-"));
  try {
    await persistHostEnvironment(directory, dummyEnvironment);
    const path = join(directory, "service-environment.json");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    const serialized = await readFile(path, "utf8");
    assert.ok(!serialized.includes(dummyEnvironment.UNRELATED_SECRET));
    assert.ok(!serialized.includes(dummyEnvironment.TMPDIR));
    const target: NodeJS.ProcessEnv = { TMPDIR: "/private-child-temp" };
    await loadHostEnvironment(directory, target);
    assert.equal(target.OPENAI_API_KEY, dummyEnvironment.OPENAI_API_KEY);
    assert.equal(target.TMPDIR, "/private-child-temp");
    await persistHostEnvironment(directory, { OPENAI_API_KEY: "dummy-rotated-credential" });
    const restarted: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "dummy-stale-manager-credential",
      CODEX_HOME: "/dummy/stale-config",
      TMPDIR: "/private-child-temp",
      UNRELATED_SETTING: "preserved",
    };
    await loadHostEnvironment(directory, restarted);
    assert.deepEqual(restarted, {
      OPENAI_API_KEY: "dummy-rotated-credential",
      TMPDIR: "/private-child-temp",
      UNRELATED_SETTING: "preserved",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing snapshots are optional and invalid snapshots do not expose their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-environment-"));
  try {
    await loadHostEnvironment(directory, {});
    await writeFile(
      join(directory, "service-environment.json"),
      "dummy-private-corrupted-credential",
      { mode: 0o600 },
    );
    await assert.rejects(
      loadHostEnvironment(directory, {}),
      (error: unknown) =>
        error instanceof Error &&
        /invalid/.test(error.message) &&
        !error.message.includes("credential"),
    );
    await writeFile(
      join(directory, "service-environment.json"),
      JSON.stringify({ NODE_OPTIONS: "unsafe", OPENAI_API_KEY: "dummy-key" }),
    );
    const target: NodeJS.ProcessEnv = {};
    await loadHostEnvironment(directory, target);
    assert.deepEqual(target, { OPENAI_API_KEY: "dummy-key" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment reads reject symlinks and files readable by other users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-environment-"));
  try {
    const target = join(directory, "target.json"),
      path = join(directory, "service-environment.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(loadHostEnvironment(directory, {}), /private file/);
    await rm(path);
    if (process.platform !== "win32") {
      await writeFile(path, "{}", { mode: 0o600 });
      await chmod(path, 0o644);
      await assert.rejects(loadHostEnvironment(directory, {}), /private file/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service definitions never embed provider credentials, proxies or configuration paths", () => {
  const options = {
    directory: "/dummy/state",
    executable: "/dummy/node",
    arguments: ["/dummy/host.js"],
    path: "/usr/bin",
    environment: dummyEnvironment,
  };
  for (const definition of [
    systemdHostUnit(options),
    launchdHostAgent(options, "app.tidy.host.fixture"),
  ]) {
    for (const [key, value] of Object.entries(dummyEnvironment)) {
      assert.ok(!definition.includes(key));
      if (value.length > 1) assert.ok(!definition.includes(value));
    }
  }
});
