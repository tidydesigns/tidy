import { afterEach, expect, test } from "bun:test";
import { HarnessUpdates } from "./harness-updates";
import type { HarnessInstallation, MaintenanceCommand } from "./harness-installation";
import type {
  HarnessUpdateState,
  UpdatableHarnessId,
} from "../../shared/contracts/harness-updates";

const updates: HarnessUpdates[] = [];
afterEach(async () => {
  for (const updater of updates.splice(0)) await updater.close();
});
/** Describe a synthetic CLI whose version can advance independently during an update. */
const installation = (id: UpdatableHarnessId, version = "1.2.3"): HarnessInstallation => ({
  id,
  version,
  executable: `/global/${id}`,
  packageName: `fixture-${id}`,
  channel: "latest",
  command: { executable: `/global/${id}`, args: ["update"] },
});
/** Create an isolated updater with observable reservations, commands and installed versions. */
function fixture(installDisabledReason?: string, now?: () => number) {
  const installed = new Map<UpdatableHarnessId, HarnessInstallation>([
    ["codex", installation("codex")],
    ["claude", installation("claude")],
    ["opencode", installation("opencode")],
  ]);
  const commands: MaintenanceCommand[] = [];
  const completed: UpdatableHarnessId[] = [];
  const busy = new Set<UpdatableHarnessId>();
  const reservations: Array<{ id: UpdatableHarnessId; allowActiveRuns: boolean }> = [];
  let releaseCount = 0;
  let run = async (command: MaintenanceCommand) => {
    commands.push(command);
    const id = command.executable.split("/").at(-1) as UpdatableHarnessId;
    installed.set(id, installation(id, "1.3.0"));
    return "";
  };
  let latest: (installation: HarnessInstallation) => Promise<string> = async () => "1.3.0";
  const updater = new HarnessUpdates({
    installDisabledReason,
    now,
    inspect: async (id) => structuredClone(installed.get(id) ?? null),
    latest: async (installation) => latest(installation),
    reserve(id, options) {
      reservations.push({ id, ...options });
      if (busy.has(id) && !options.allowActiveRuns) return null;
      busy.add(id);
      return () => {
        busy.delete(id);
        releaseCount++;
      };
    },
    run: async (command) => run(command),
    installed: (id) => {
      completed.push(id);
    },
  });
  updates.push(updater);
  return {
    updater,
    installed,
    commands,
    completed,
    busy,
    reservations,
    releases: () => releaseCount,
    setRun: (value: typeof run) => {
      run = value;
    },
    setLatest: (value: typeof latest) => {
      latest = value;
    },
  };
}
/** Wait for a provider's emitted lifecycle state, failing rather than hanging on a regression. */
function until(
  updater: HarnessUpdates,
  id: UpdatableHarnessId,
  status: HarnessUpdateState["status"],
) {
  if (updater.state.some((entry) => entry.id === id && entry.status === status))
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${id}:${status}`));
    }, 2500);
    const unsubscribe = updater.subscribe((state) => {
      if (!state.some((entry) => entry.id === id && entry.status === status)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

test("discovery alerts for all installed CLIs, omits absent CLIs and never installs automatically", async () => {
  const { updater, installed, commands } = fixture();
  await updater.check();
  expect(updater.state.map((entry) => [entry.id, entry.status])).toEqual([
    ["codex", "available"],
    ["claude", "available"],
    ["opencode", "available"],
  ]);
  expect(commands).toHaveLength(0);
  expect(JSON.stringify(updater.state)).not.toContain("/global/");
  installed.delete("opencode");
  installed.set("claude", installation("claude", "1.4.0"));
  await updater.check(true);
  expect(updater.state.map((entry) => [entry.id, entry.status])).toEqual([
    ["codex", "available"],
    ["claude", "current"],
  ]);
});

test("offline checks preserve a known update and focus checks are throttled", async () => {
  const { updater, setLatest } = fixture();
  await updater.check();
  let calls = 0;
  setLatest(async () => {
    calls++;
    throw new Error("offline token=private");
  });
  await updater.check();
  expect(calls).toBe(0);
  await updater.check(true);
  expect(calls).toBe(3);
  expect(updater.state.every((entry) => entry.status === "available")).toBe(true);
  expect(JSON.stringify(updater.state)).not.toContain("private");
});

test("one click queues an active harness, deduplicates clicks and installs once idle", async () => {
  const { updater, commands, completed, busy, releases } = fixture();
  busy.add("codex");
  await updater.check();
  updater.install("codex");
  updater.install("codex");
  expect(updater.state.find((entry) => entry.id === "codex")?.status).toBe("queued");
  expect(updater.state.find((entry) => entry.id === "codex")?.waitReason).toBe("turn");
  expect(commands).toHaveLength(0);
  busy.delete("codex");
  await until(updater, "codex", "updated");
  await Promise.resolve();
  expect(commands).toHaveLength(1);
  expect(completed).toEqual(["codex"]);
  expect(releases()).toBe(1);
  expect(updater.state.find((entry) => entry.id === "codex")?.installedVersion).toBe("1.3.0");
});

test("installers are serialized, failures are sanitized and a retry verifies the installed version", async () => {
  const { updater, installed, setRun, releases } = fixture();
  await updater.check();
  let finish!: () => void;
  let calls = 0;
  setRun(async () => {
    calls++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw new Error("/Users/private/.npmrc token=secret");
  });
  updater.install("codex");
  await until(updater, "codex", "installing");
  // Let installation revalidation reach the command before finishing it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  updater.install("claude");
  expect(calls).toBe(1);
  expect(updater.state.find((entry) => entry.id === "claude")?.status).toBe("queued");
  expect(updater.state.find((entry) => entry.id === "claude")?.waitReason).toBe("installer");
  setRun(async (command) => {
    installed.set(
      command.executable.endsWith("claude") ? "claude" : "codex",
      installation(command.executable.endsWith("claude") ? "claude" : "codex", "1.3.0"),
    );
    return "";
  });
  finish();
  await until(updater, "codex", "error");
  await until(updater, "claude", "updated");
  expect(JSON.stringify(updater.state)).not.toMatch(/secret|private|npmrc/);
  updater.install("codex");
  await until(updater, "codex", "updated");
  await Promise.resolve();
  expect(releases()).toBe(3);
});

test("a successful command without an actual version update is an error", async () => {
  const { updater, setRun, completed } = fixture();
  await updater.check();
  setRun(async () => "already up to date");
  updater.install("codex");
  await until(updater, "codex", "error");
  expect(completed).toEqual([]);
});

test("only an explicitly background-safe installation may update during an active response", async () => {
  const { updater, installed, busy, reservations } = fixture();
  busy.add("claude");
  installed.set("claude", { ...installation("claude"), canUpdateWhileRunning: true });
  await updater.check();
  updater.install("claude");
  await until(updater, "claude", "updated");
  expect(reservations.find((entry) => entry.id === "claude")?.allowActiveRuns).toBe(true);
  await Promise.resolve();
  busy.add("codex");
  updater.install("codex");
  expect(updater.state.find((entry) => entry.id === "codex")).toMatchObject({
    status: "queued",
    waitReason: "turn",
  });
  expect(reservations.find((entry) => entry.id === "codex")?.allowActiveRuns).toBe(false);
});

test("revalidation refuses a changed executable or install method", async () => {
  const { updater, installed, commands } = fixture();
  await updater.check();
  installed.set("codex", { ...installation("codex"), executable: "/different/codex" });
  updater.install("codex");
  await until(updater, "codex", "error");
  expect(commands).toHaveLength(0);
});

test("an externally completed update is verified without invoking another installer", async () => {
  const { updater, installed, commands } = fixture();
  await updater.check();
  installed.set("codex", {
    ...installation("codex", "1.4.0"),
    executable: "/new-version/bin/codex",
  });
  updater.install("codex");
  await until(updater, "codex", "updated");
  expect(commands).toHaveLength(0);
});

test("an older in-flight discovery cannot overwrite a finished installation", async () => {
  const { updater, setLatest } = fixture();
  await updater.check();
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  setLatest(async () => {
    await delayed;
    return "1.3.0";
  });
  const checking = updater.check(true);
  updater.install("codex");
  await until(updater, "codex", "updated");
  finish();
  await checking;
  expect(updater.state.find((entry) => entry.id === "codex")).toMatchObject({
    status: "updated",
    installedVersion: "1.3.0",
  });
});

test("custom installations still alert but cannot start an unknown updater", async () => {
  const { updater, installed, commands } = fixture();
  installed.set("codex", { ...installation("codex"), command: undefined });
  await updater.check();
  expect(updater.state.find((entry) => entry.id === "codex")).toMatchObject({
    status: "available",
    canInstall: false,
  });
  expect(() => updater.install("codex")).toThrow("No installable update");
  expect(commands).toHaveLength(0);
});

test("quit cancels queued updates and waits for an active installer to finish", async () => {
  const { updater, installed, setRun, commands } = fixture();
  let finish!: () => void;
  setRun(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    installed.set("codex", installation("codex", "1.3.0"));
    return "";
  });
  await updater.check();
  updater.install("codex");
  updater.install("claude");
  await new Promise((resolve) => setTimeout(resolve, 0));
  let closed = false;
  const closing = updater.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(() => updater.install("opencode")).toThrow("closing");
  finish();
  await closing;
  expect(commands).toHaveLength(0);
  expect(updater.state.find((entry) => entry.id === "codex")?.status).toBe("updated");
  expect(updater.state.find((entry) => entry.id === "claude")?.status).toBe("queued");
});

test("attached backend policy discovers updates but cannot reserve or install providers", async () => {
  const reason = "Agent updates require desktop ownership of the backend.";
  const f = fixture(reason);
  f.installed.set("claude", { ...installation("claude"), canUpdateWhileRunning: true });
  await f.updater.check();
  for (const id of ["codex", "claude", "opencode"] as const) {
    expect(f.updater.state.find((entry) => entry.id === id)).toMatchObject({
      status: "available",
      latestVersion: "1.3.0",
      canInstall: false,
      message: reason,
    });
    expect(() => f.updater.install(id)).toThrow(reason);
  }
  expect(f.reservations).toEqual([]);
  expect(f.commands).toEqual([]);
  expect(f.updater.busy).toBe(false);
});

test("failed first discovery is visible, sanitized and retries only failed providers with backoff", async () => {
  let now = 0;
  const f = fixture(undefined, () => now);
  const calls = { codex: 0, claude: 0, opencode: 0 };
  let offline = true;
  f.setLatest(async ({ id }) => {
    calls[id]++;
    if (id === "codex" && offline) throw new Error("/private/token=secret");
    return "1.3.0";
  });
  await f.updater.check();
  expect(f.updater.state[0]).toMatchObject({
    id: "codex",
    status: "check-error",
    canInstall: false,
  });
  expect(JSON.stringify(f.updater.state)).not.toMatch(/private|secret/);
  expect(() => f.updater.install("codex")).toThrow("No installable update");
  now = 59_999;
  await f.updater.check();
  expect(calls).toEqual({ codex: 1, claude: 1, opencode: 1 });
  now = 60_000;
  await f.updater.check();
  expect(calls).toEqual({ codex: 2, claude: 1, opencode: 1 });
  now = 179_999;
  await f.updater.check();
  expect(calls.codex).toBe(2);
  offline = false;
  now = 180_000;
  await f.updater.check();
  expect(f.updater.state[0]).toMatchObject({ status: "available", canInstall: true });
  expect(f.updater.state[0].checkError).toBeUndefined();
  expect(f.commands).toHaveLength(0);
  now += 60_000;
  await f.updater.check();
  expect(calls.codex).toBe(3);
});

test("concurrent rechecks coalesce and late failures cannot replace an explicit update", async () => {
  const f = fixture();
  await f.updater.check();
  let reject!: (error: Error) => void;
  const delayed = new Promise<string>((_, fail) => {
    reject = fail;
  });
  let calls = 0;
  f.setLatest(async () => {
    calls++;
    return delayed;
  });
  const check = f.updater.check(true);
  expect(f.updater.check(true)).toBe(check);
  await Promise.resolve();
  f.updater.install("codex");
  await until(f.updater, "codex", "updated");
  reject(new Error("offline"));
  await check;
  expect(calls).toBe(3);
  expect(f.updater.state[0]).toMatchObject({ status: "updated", installedVersion: "1.3.0" });
  expect(f.updater.state[0].checkError).toBeUndefined();
});

test("offline refresh observes removal and externally updated versions without stale prompts", async () => {
  const f = fixture();
  await f.updater.check();
  f.installed.delete("opencode");
  f.installed.set("claude", installation("claude", "1.4.0"));
  f.setLatest(async () => {
    throw new Error("offline");
  });
  await f.updater.check(true);
  expect(f.updater.state.map(({ id, status }) => [id, status])).toEqual([
    ["codex", "available"],
    ["claude", "current"],
  ]);
  expect(f.updater.state[1].installedVersion).toBe("1.4.0");
  expect(f.updater.state[0].checkError).toContain("try again automatically");
  f.installed.set("claude", installation("claude", "1.2.0"));
  await f.updater.check(true);
  expect(f.updater.state[1]).toMatchObject({ status: "available", installedVersion: "1.2.0" });
});

test("a failed check never reuses a release from a changed installation channel", async () => {
  const f = fixture();
  await f.updater.check();
  f.installed.set("claude", { ...installation("claude"), channel: "stable" });
  f.setLatest(async () => {
    throw new Error("offline");
  });
  await f.updater.check(true);
  expect(f.updater.state.find(({ id }) => id === "claude")).toMatchObject({
    status: "check-error",
    canInstall: false,
    latestVersion: "",
  });
  expect(() => f.updater.install("claude")).toThrow("No installable update");
});

test("background checks retain explicit installation errors until resolved or a new release exists", async () => {
  const f = fixture();
  await f.updater.check();
  f.setRun(async () => {
    throw new Error("installer failed");
  });
  f.updater.install("codex");
  await until(f.updater, "codex", "error");
  const message = f.updater.state[0].message;
  await f.updater.check(true);
  expect(f.updater.state[0]).toMatchObject({ status: "error", message });
  f.setLatest(async () => "1.4.0");
  await f.updater.check(true);
  expect(f.updater.state[0].status).toBe("available");
});

test("inspection failures produce retryable diagnostics rather than implying no installation", async () => {
  let now = 0;
  let failed = true;
  const updater = new HarnessUpdates({
    now: () => now,
    reserve: () => {
      throw new Error("must never reserve");
    },
    inspect: async () => {
      if (failed) throw new Error("unsupported version /private/config");
      return null;
    },
  });
  updates.push(updater);
  await updater.check();
  expect(updater.state).toHaveLength(3);
  expect(updater.state.every((entry) => entry.status === "check-error")).toBe(true);
  expect(JSON.stringify(updater.state)).not.toMatch(/private|unsupported version/);
  failed = false;
  now = 60_000;
  await updater.check();
  expect(updater.state).toEqual([]);
});

test("a queued update cannot cross a release-channel change", async () => {
  const f = fixture();
  f.busy.add("claude");
  await f.updater.check();
  f.updater.install("claude");
  f.installed.set("claude", { ...installation("claude"), channel: "stable" });
  f.busy.delete("claude");
  await until(f.updater, "claude", "error");
  expect(f.commands).toHaveLength(0);
});

test("a failed version probe preserves known availability but disables stale installation actions", async () => {
  let probeFailed = false;
  let metadataFailed = false;
  const updater = new HarnessUpdates({
    inspect: async (id) => {
      if (probeFailed) throw new Error("probe failed");
      return installation(id);
    },
    latest: async () => {
      if (metadataFailed) throw new Error("offline");
      return "1.3.0";
    },
    reserve: () => {
      throw new Error("must never reserve");
    },
  });
  updates.push(updater);
  await updater.check();
  probeFailed = true;
  await updater.check(true);
  expect(updater.state[0]).toMatchObject({ status: "available", canInstall: false });
  expect(() => updater.install("codex")).toThrow("No installable update");
  probeFailed = false;
  metadataFailed = true;
  await updater.check(true);
  expect(updater.state[0]).toMatchObject({ status: "available", canInstall: true });
});

test("newly installed CLIs are discovered after one minute without rechecking healthy providers", async () => {
  let now = 0;
  const f = fixture(undefined, () => now);
  f.installed.delete("opencode");
  const calls: UpdatableHarnessId[] = [];
  f.setLatest(async ({ id }) => {
    calls.push(id);
    return "1.3.0";
  });
  await f.updater.check();
  expect(f.updater.state).toHaveLength(2);
  f.installed.set("opencode", installation("opencode"));
  now = 60_000;
  await f.updater.check();
  expect(calls).toEqual(["codex", "claude", "opencode"]);
  expect(f.updater.state[2]).toMatchObject({ id: "opencode", status: "available" });
  expect(f.commands).toHaveLength(0);
});

test("only an active installer blocks app updates, including during its first published state", async () => {
  const f = fixture();
  await f.updater.check();
  expect(f.updater.busy).toBe(false);
  expect(f.updater.installing).toBe(false);
  f.busy.add("codex");
  f.updater.install("codex");
  expect(f.updater.busy).toBe(true);
  expect(f.updater.installing).toBe(false);

  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.setRun(async () => {
    await running;
    f.installed.set("claude", installation("claude", "1.3.0"));
    return "";
  });
  const observed: boolean[] = [];
  const unsubscribe = f.updater.subscribe((entries) => {
    if (entries.some((entry) => entry.status === "installing")) observed.push(f.updater.installing);
  });
  f.updater.install("claude");
  const activeImmediately = f.updater.installing;
  finish();
  expect(activeImmediately).toBe(true);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(Boolean)).toBe(true);
  await until(f.updater, "claude", "updated");
  await Promise.resolve();
  unsubscribe();
  expect(f.updater.installing).toBe(false);
  expect(f.updater.busy).toBe(true);
  expect(f.updater.state[0]).toMatchObject({ id: "codex", status: "queued" });
});
