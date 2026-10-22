import { afterEach, expect, test } from "bun:test";
import { HarnessUpdates } from "./harness-updates";
import type { HarnessInstallation, MaintenanceCommand } from "./harness-installation";
import type { HarnessUpdateState, UpdatableHarnessId } from "../shared/harness-updates";

const updates: HarnessUpdates[] = [];
afterEach(async () => {
  for (const updater of updates.splice(0)) await updater.close();
});
const installation = (id: UpdatableHarnessId, version = "1.2.3"): HarnessInstallation => ({
  id,
  version,
  executable: `/global/${id}`,
  packageName: `fixture-${id}`,
  channel: "latest",
  command: { executable: `/global/${id}`, args: ["update"] },
});
function fixture() {
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
  let latest = async () => "1.3.0";
  const updater = new HarnessUpdates({
    inspect: async (id) => structuredClone(installed.get(id) ?? null),
    latest: async () => latest(),
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
