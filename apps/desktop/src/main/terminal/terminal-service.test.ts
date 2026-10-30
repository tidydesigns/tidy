import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { IPty } from "@lydell/node-pty";
import { TerminalService, terminalEnvironment } from "./terminal-service";
import { terminalScopeSchema, type TerminalOutput } from "../../shared/contracts/terminal";
import { WorkspaceService } from "../workspace/workspace-service";
import type { ProjectStore } from "../workspace/project-store";

const services: TerminalService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function fixture() {
  const projectId = randomUUID();
  const writes: string[] = [];
  const sizes: [number, number][] = [];
  let output: (data: string) => void = () => {};
  let exit: (value: { exitCode: number }) => void = () => {};
  let kills = 0,
    pauses = 0,
    resumes = 0,
    starts = 0;
  const pty = {
    write: (data: string) => writes.push(data),
    resize: (cols: number, rows: number) => sizes.push([cols, rows]),
    kill: () => {
      kills++;
      exit({ exitCode: 0 });
    },
    pause: () => pauses++,
    resume: () => resumes++,
    onData: (listener: typeof output) => {
      output = listener;
      return { dispose() {} };
    },
    onExit: (listener: typeof exit) => {
      exit = listener;
      return { dispose() {} };
    },
  } as unknown as IPty;
  const service = new TerminalService(
    async (id) => {
      if (id !== projectId) throw new Error("Unknown project.");
      return "/synthetic/project";
    },
    (_shell, _args, options) => {
      starts++;
      expect(options?.cwd).toBe("/synthetic/project");
      expect(options?.env?.COLORTERM).toBe("truecolor");
      return pty;
    },
  );
  services.push(service);
  const events: TerminalOutput[] = [];
  return {
    projectId,
    service,
    events,
    writes,
    sizes,
    emit: (data: string) => output(data),
    counts: () => ({ kills, pauses, resumes, starts }),
  };
}
function snapshot(events: TerminalOutput[]) {
  const value = events.find((event) => event.kind === "snapshot");
  if (value?.kind !== "snapshot") throw new Error("Missing terminal snapshot.");
  return value;
}
test("project terminal watches share one shell, retain output while detached, and reject stale session input", async () => {
  const f = fixture();
  const scope = { projectId: f.projectId, cols: 80, rows: 24 };
  const [first, second] = await Promise.all([
    f.service.watch(scope, (event) => f.events.push(event)),
    f.service.watch(scope, () => {}),
  ]);
  expect(f.counts().starts).toBe(1);
  const initial = snapshot(f.events);
  first.input({ kind: "write", sessionId: randomUUID(), data: "ignored" });
  first.input({ kind: "write", sessionId: initial.sessionId, data: "nvim\r" });
  expect(f.writes).toEqual(["nvim\r"]);
  first.input({ kind: "resize", sessionId: initial.sessionId, cols: 100, rows: 30 });
  expect(f.sizes.at(-1)).toEqual([100, 30]);
  first.close();
  second.close();
  f.emit("retained shell output\n");
  await Bun.sleep(15);
  const replay: TerminalOutput[] = [];
  await f.service.watch(
    { ...scope, resume: { sessionId: initial.sessionId, sequence: initial.sequence } },
    (event) => replay.push(event),
  );
  expect(snapshot(replay)).toMatchObject({
    reset: false,
    data: "retained shell output\n",
    sessionId: initial.sessionId,
  });
  expect(f.counts().kills).toBe(0);
  f.service.end(f.projectId, randomUUID());
  expect(f.counts().kills).toBe(0);
  f.service.end(f.projectId, initial.sessionId);
  expect(f.counts().kills).toBe(1);
  first.input({ kind: "write", sessionId: initial.sessionId, data: "late" });
  expect(f.writes).toEqual(["nvim\r"]);
});
test("terminal output has bounded history and backpressure until the renderer acknowledges it", async () => {
  const f = fixture();
  const scope = { projectId: f.projectId, cols: 80, rows: 24 };
  const watch = await f.service.watch(scope, (event) => f.events.push(event));
  const initial = snapshot(f.events);
  for (let i = 0; i < 10; i++) f.emit("x".repeat(16_000));
  expect(f.counts().pauses).toBe(1);
  const last = f.events.at(-1);
  if (last?.kind !== "data") throw new Error("Missing output.");
  watch.input({ kind: "ack", sessionId: initial.sessionId, sequence: last.sequence });
  expect(f.counts().resumes).toBe(1);
  watch.close();
  for (let i = 0; i < 100; i++) f.emit("y".repeat(16_000));
  const replay: TerminalOutput[] = [];
  await f.service.watch(
    { ...scope, resume: { sessionId: initial.sessionId, sequence: 0 } },
    (event) => replay.push(event),
  );
  expect(snapshot(replay).reset).toBe(true);
  expect(Buffer.byteLength(snapshot(replay).data)).toBeLessThanOrEqual(1024 * 1024);
});
test("unknown and cloud projects cannot acquire a terminal and scope cannot inject shell paths", async () => {
  const f = fixture();
  await expect(
    f.service.watch({ projectId: randomUUID(), cols: 80, rows: 24 }, () => {}),
  ).rejects.toThrow("Unknown project");
  expect(
    terminalScopeSchema.safeParse({
      projectId: f.projectId,
      cols: 80,
      rows: 24,
      shell: "/tmp/evil",
      cwd: "/tmp",
    }).success,
  ).toBe(false);
  const cloud = new WorkspaceService({
    project: () => ({ cloud: true }),
  } as unknown as ProjectStore);
  cloud.authorizeCloudProject = async () => {};
  await expect(
    cloud.terminal.watch({ projectId: f.projectId, cols: 80, rows: 24 }, () => {}),
  ).rejects.toThrow("local code project");
  await cloud.terminal.close();
  expect(f.counts().starts).toBe(0);
  await f.service.close();
  await expect(
    f.service.watch({ projectId: f.projectId, cols: 80, rows: 24 }, () => {}),
  ).rejects.toThrow("closing");
});
test("terminal environment advertises true colour without inheriting application credentials or Node injection options", () => {
  const env = terminalEnvironment();
  expect(env.TERM).toBe("xterm-256color");
  expect(env.COLORTERM).toBe("truecolor");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "NO_COLOR",
  ])
    expect(env[key]).toBeUndefined();
  expect(
    env.PATH.split(process.platform === "win32" ? ";" : ":").every(
      (path) => path.startsWith("/") || /^[A-Z]:\\/i.test(path),
    ),
  ).toBe(true);
});

test("a viewer canceled during project resolution cannot start a shell", async () => {
  const projectId = randomUUID();
  let admitted = true;
  let starts = 0;
  const ready = Promise.withResolvers<string>();
  const service = new TerminalService(
    () => ready.promise,
    () => {
      starts++;
      throw new Error("Must not spawn");
    },
  );
  services.push(service);
  const watching = service.watch(
    { projectId, cols: 80, rows: 24 },
    () => {},
    () => admitted,
  );
  admitted = false;
  ready.resolve("/synthetic/project");
  await expect(watching).rejects.toThrow("viewer closed");
  expect(starts).toBe(0);
});
