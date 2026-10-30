import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadPorts } from "./thread-ports";
import { PrivateState } from "../platform/private-state";
import { startHarness } from "../harnesses/harnesses";
import { HarnessSessions } from "../harnesses/harness-sessions";
import { HarnessTransport } from "../harnesses/harness-transport";
import { parseLinuxListeners, parseLinuxProcess, parseLsofListeners } from "./port-scanner";

const children: ChildProcess[] = [];
const detachedPids: number[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childExit(child);
  }
  for (const pid of detachedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function childExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

async function server(environment: Record<string, string> = {}, count = 1) {
  const child = spawn(
    "node",
    [
      "-e",
      `
const { createServer } = require('node:net');
const servers = Array.from({ length: ${count} }, () => createServer());
Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
 .then(() => process.stdout.write(JSON.stringify(servers.map(server => server.address().port)) + '\\n'));
`,
    ],
    { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const ports = await new Promise<number[]>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString())));
  });
  return { child, ports };
}

const supported = process.platform === "linux" || process.platform === "darwin";

test.skipIf(!supported)(
  "ports are thread scoped; stopping a process closes its ports without affecting other servers",
  async () => {
    const manager = new ThreadPorts();
    const projectId = randomUUID(),
      threadId = randomUUID(),
      otherThreadId = randomUUID();
    const first = await manager.register({ projectId, threadId });
    const second = await manager.register({ projectId, threadId: otherThreadId });
    const a = await server(first.environment, 2);
    const b = await server(second.environment);
    const external = await server();
    const ports = await manager.list({ projectId, threadId });
    expect(ports.map((entry) => entry.port).sort()).toEqual(a.ports.sort());
    expect(new Set(ports.map((entry) => entry.processId)).size).toBe(1);
    const others = await manager.list({ projectId, threadId: otherThreadId });
    expect(others.map((entry) => entry.port)).toEqual(b.ports);
    expect(await manager.list({ projectId: randomUUID(), threadId })).toEqual([]);
    await expect(
      manager.stop({ projectId, threadId: otherThreadId, portId: ports[0].id }),
    ).rejects.toThrow("no longer owned");
    await manager.stop({ projectId, threadId, portId: ports[0].id });
    await childExit(a.child);
    expect(a.child.signalCode).toBe("SIGTERM");
    expect(b.child.exitCode).toBeNull();
    expect(b.child.signalCode).toBeNull();
    expect(external.child.signalCode).toBeNull();
    expect(await manager.list({ projectId, threadId })).toEqual([]);
    expect(
      (await manager.list({ projectId, threadId: otherThreadId })).map((entry) => entry.port),
    ).toEqual(b.ports);
  },
  15000,
);

for (const warm of [false, true]) {
  test.skipIf(!supported)(
    `native harness tags survive turn completion and ownership reload (warm: ${warm})`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tidy-thread-ports-"));
      directories.push(directory);
      const state = new PrivateState(join(directory, "private"));
      await state.initialize();
      const manager = new ThreadPorts(state);
      const projectId = randomUUID(),
        threadId = randomUUID();
      const registration = await manager.register({ projectId, threadId });
      const executable = join(directory, "agent.cjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
 const value = JSON.parse(line);
 if (value.method === 'initialize') send({ id: value.id, result: {} });
 if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: '${randomUUID()}' } } });
 if (value.method === 'turn/start') {
  send({ id: value.id, result: { turn: { id: 'turn' } } });
  const server = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0, '127.0.0.1', function () { process.send({ pid: process.pid, port: this.address().port }); });"],
   { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  server.on('message', info => {
   writeFileSync('server.json', JSON.stringify(info));
   server.disconnect(); server.unref();
   send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  });
 }
});
`,
      );
      await chmod(executable, 0o700);
      const sessions = new HarnessSessions();
      let registrations = 0;
      let nativeRegistration = registration;
      const context = {
        projectId,
        harness: "codex" as const,
        executable,
        cwd: directory,
        processRegistration: async () => {
          registrations++;
          nativeRegistration = await manager.register({ projectId, threadId: null });
          return nativeRegistration;
        },
      };
      if (warm) {
        await sessions.prepare({ kind: "composer", id: projectId, context });
        await sessions.prepare({ kind: "composer", id: projectId, context });
      }
      const launcherExit = Promise.withResolvers<void>();
      const turn = { prompt: "Start a preview", onUpdate() {} };
      const harness = warm
        ? sessions.start(threadId, { ...context, ...turn })
        : startHarness({
            harness: "codex",
            executable,
            cwd: directory,
            prompt: "Start a preview",
            ...registration,
            onExit() {
              registration.onExit();
              launcherExit.resolve();
            },
            onUpdate() {},
          });
      try {
        await harness.done;
        if (!warm) await launcherExit.promise;
        if (warm) expect(registrations).toBe(1);
        const server: { pid: number; port: number } = JSON.parse(
          await readFile(join(directory, "server.json"), "utf8"),
        );
        detachedPids.push(server.pid);
        expect((await manager.list({ projectId, threadId })).map((entry) => entry.port)).toEqual([
          server.port,
        ]);
        const restored = new ThreadPorts(new PrivateState(join(directory, "private")));
        const ports = await restored.list({ projectId, threadId });
        expect(ports.map((entry) => entry.port)).toEqual([server.port]);
        expect(JSON.stringify(ports)).not.toContain(
          Object.values(nativeRegistration.environment)[0],
        );
        await restored.stop({ projectId, threadId, portId: ports[0].id });
        expect(await restored.list({ projectId, threadId })).toEqual([]);
      } finally {
        harness.stop();
        await harness.done.catch(() => {});
        await sessions.clear();
      }
    },
    15000,
  );
}

test.skipIf(!supported)(
  "stale port identifiers cannot stop a replacement process",
  async () => {
    const manager = new ThreadPorts();
    const projectId = randomUUID(),
      threadId = randomUUID();
    const registration = await manager.register({ projectId, threadId });
    const original = await server(registration.environment);
    const ports = await manager.list({ projectId, threadId });
    original.child.kill("SIGTERM");
    await childExit(original.child);
    const replacement = await server(registration.environment);
    await expect(manager.stop({ projectId, threadId, portId: ports[0].id })).rejects.toThrow(
      "changed before",
    );
    expect(replacement.child.signalCode).toBeNull();
  },
  15000,
);

test.skipIf(!supported)("the agent root process is never offered for stopping", async () => {
  const manager = new ThreadPorts();
  const projectId = randomUUID(),
    threadId = randomUUID();
  const registration = await manager.register({ projectId, threadId });
  const root = await server(registration.environment);
  registration.onSpawn(root.child.pid!);
  expect(await manager.list({ projectId, threadId })).toEqual([]);
});

test.skipIf(!supported)(
  "supervised harness roots stay protected after ownership reload",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tidy-supervised-ports-"));
    directories.push(directory);
    const state = new PrivateState(directory);
    await state.initialize();
    const manager = new ThreadPorts(state);
    const projectId = randomUUID(),
      threadId = randomUUID();
    const registration = await manager.register({ projectId, threadId });
    const ready = Promise.withResolvers<{ root: number; child: number }>();
    const transport = new HarnessTransport({
      executable: "node",
      args: [
        "-e",
        `
const { spawn } = require('node:child_process');
const root = require('node:net').createServer();
root.listen(0, '127.0.0.1', () => {
 const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0, '127.0.0.1', function () { process.send(this.address().port); });"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
 child.on('message', port => process.stdout.write(JSON.stringify({method:'ready',params:{root:root.address().port,child:port}})+'\\n'));
});
`,
      ],
      cwd: directory,
      protocol: "jsonrpc",
      superviseParent: true,
      env: { ...process.env, ...registration.environment },
      onSpawn: registration.onSpawn,
      onExit: registration.onExit,
    });
    transport.onMessage = (message) => {
      if (message.method === "ready")
        ready.resolve(z.object({ root: z.number(), child: z.number() }).parse(message.params));
    };
    try {
      const ports = await ready.promise;
      await manager.flush();
      const restored = new ThreadPorts(state);
      const entries = await restored.list({ projectId, threadId });
      expect(entries.map((entry) => entry.port)).toEqual([ports.child]);
      await restored.stop({ projectId, threadId, portId: entries[0].id });
      expect(transport.available).toBe(true);
      expect(await restored.list({ projectId, threadId })).toEqual([]);
    } finally {
      transport.close();
      await transport.done;
    }
  },
  15000,
);

test.skipIf(!supported)(
  "dead ownership is pruned at capacity without losing non-listening processes",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tidy-owner-pruning-"));
    directories.push(directory);
    const state = new PrivateState(directory);
    await state.initialize();
    const projectId = randomUUID(),
      threadId = randomUUID();
    const liveToken = randomUUID();
    const live = spawn(
      "node",
      ["-e", "setInterval(() => {}, 1000); process.stdout.write('ready');"],
      {
        env: { ...process.env, TIDY_THREAD_OWNER: liveToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(live);
    await once(live.stdout!, "data");
    await state.write("thread-port-owners", [
      { token: liveToken, projectId, threadId, rootPid: live.pid },
      ...Array.from({ length: 19_999 }, () => ({ token: randomUUID(), projectId, threadId })),
    ]);
    const manager = new ThreadPorts(state);
    const registration = await manager.register({ projectId, threadId });
    const owners = z
      .array(z.object({ token: z.string() }))
      .parse(await state.read("thread-port-owners"));
    expect(owners).toHaveLength(2);
    expect(owners.some((entry) => entry.token === liveToken)).toBe(true);
    expect(owners.some((entry) => entry.token === registration.environment.TIDY_THREAD_OWNER)).toBe(
      true,
    );
    registration.onExit();
  },
  15000,
);

test.skipIf(!supported)("warm ownership binds to one thread and cannot be reassigned", async () => {
  const manager = new ThreadPorts();
  const projectId = randomUUID(),
    threadId = randomUUID(),
    otherThreadId = randomUUID();
  const registration = await manager.register({ projectId, threadId: null });
  const running = await server(registration.environment);
  expect(await manager.list({ projectId, threadId })).toEqual([]);
  await registration.bind(threadId);
  const ports = await manager.list({ projectId, threadId });
  expect(ports.map((entry) => entry.port)).toEqual(running.ports);
  await expect(registration.bind(otherThreadId)).rejects.toThrow("another thread");
  expect(await manager.list({ projectId, threadId: otherThreadId })).toEqual([]);
  await manager.stop({ projectId, threadId, portId: ports[0].id });
});

test.skipIf(!supported)("several processes in one thread stop independently", async () => {
  const manager = new ThreadPorts();
  const projectId = randomUUID(),
    threadId = randomUUID();
  const registration = await manager.register({ projectId, threadId });
  const running = await Promise.all(
    Array.from({ length: 6 }, () => server(registration.environment)),
  );
  const ports = await manager.list({ projectId, threadId });
  expect(ports).toHaveLength(6);
  expect(new Set(ports.map((entry) => entry.processId)).size).toBe(6);
  await manager.stop({ projectId, threadId, portId: ports[0].id });
  const remaining = await manager.list({ projectId, threadId });
  expect(remaining).toHaveLength(5);
  expect(
    running.filter(({ child }) => child.exitCode === null && child.signalCode === null),
  ).toHaveLength(5);
  await Promise.all(
    remaining.slice(0, 2).map((port) => manager.stop({ projectId, threadId, portId: port.id })),
  );
  expect(await manager.list({ projectId, threadId })).toHaveLength(3);
});

test.skipIf(!supported)(
  "stop escalates when a listener ignores graceful termination",
  async () => {
    const manager = new ThreadPorts();
    const projectId = randomUUID(),
      threadId = randomUUID();
    const registration = await manager.register({ projectId, threadId });
    const child = spawn(
      "node",
      [
        "-e",
        `
process.on('SIGTERM', () => {});
require('node:net').createServer().listen(0, '127.0.0.1', () => process.stdout.write('ready'));
`,
      ],
      { env: { ...process.env, ...registration.environment }, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    await once(child.stdout!, "data");
    const ports = await manager.list({ projectId, threadId });
    await manager.stop({ projectId, threadId, portId: ports[0].id });
    await childExit(child);
    expect(child.signalCode).toBe("SIGKILL");
  },
  10000,
);

test("listener parsers exclude non-local addresses and non-listening sockets", () => {
  const header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt inode";
  const row = (address: string, state: string, inode: string) =>
    `0: ${address}:0BB8 00000000:0000 ${state} 0:0 0:0 0 1000 0 ${inode}`;
  const listeners = parseLinuxListeners(
    [
      header,
      row("0100007F", "0A", "123"),
      row("00000000000000000000000001000000", "0A", "124"),
      row("0101A8C0", "0A", "125"),
      row("0100007F", "01", "126"),
    ].join("\n"),
  );
  expect([...listeners.values()]).toEqual([
    { port: 3000, host: "127.0.0.1" },
    { port: 3000, host: "::1" },
  ]);
  expect(parseLsofListeners("p100\nn*:3000\nn[::1]:4000\nn192.168.1.1:5000\n")).toEqual([
    { pid: 100, port: 3000, host: "127.0.0.1" },
    { pid: 100, port: 4000, host: "::1" },
  ]);
});

test("process identity parsing preserves names containing parentheses", () => {
  const fields = ["S", "12", ...Array(17).fill("0"), "98765"];
  expect(parseLinuxProcess(42, `42 (a (worker)) ${fields.join(" ")}`)).toEqual({
    pid: 42,
    parentPid: 12,
    identity: "42:98765",
    name: "a (worker)",
  });
});
