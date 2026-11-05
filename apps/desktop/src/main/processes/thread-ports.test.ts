import { afterEach, expect, spyOn, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
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
import {
  inspectOwnedProcess,
  inspectProcessIdentity,
  parseLinuxListeners,
  parseLinuxProcess,
  parseLsofListeners,
  type OwnedProcess,
} from "./port-scanner";

const executeFixture = promisify(execFile);
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
  await Promise.all(Array.from({ length: 6 }, () => server(registration.environment)));
  const ports = await manager.list({ projectId, threadId });
  expect(ports).toHaveLength(6);
  expect(new Set(ports.map((entry) => entry.processId)).size).toBe(6);
  await manager.stop({ projectId, threadId, portId: ports[0].id });
  const remaining = await manager.list({ projectId, threadId });
  expect(remaining).toHaveLength(5);
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

async function retirementFixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-retire-agent-"));
  directories.push(directory);
  const state = new PrivateState(directory);
  await state.initialize();
  return {
    directory,
    state,
    manager: new ThreadPorts(state),
    projectId: randomUUID(),
    threadId: randomUUID(),
  };
}

test.skipIf(!supported)(
  "retirement stops all verified roots, coalesces calls and preserves other threads",
  async () => {
    const f = await retirementFixture();
    const first = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
    const a = await server(first.environment);
    first.onSpawn(a.child.pid!);
    const second = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
    const b = await server(second.environment);
    second.onSpawn(b.child.pid!);
    const otherThreadId = randomUUID();
    const unrelated = await f.manager.register({ projectId: f.projectId, threadId: otherThreadId });
    const c = await server(unrelated.environment);
    unrelated.onSpawn(c.child.pid!);
    await f.manager.flush();
    const owners = z
      .array(z.object({ rootIdentity: z.string() }))
      .parse(await f.state.read("thread-port-owners"));
    expect(owners).toHaveLength(3);
    const restored = new ThreadPorts(f.state);
    const retiring = restored.retireAgent(f);
    expect(restored.retireAgent(f)).toBe(retiring);
    await expect(
      restored.register({ projectId: f.projectId, threadId: f.threadId }),
    ).rejects.toThrow("being retired");
    await retiring;
    await Promise.all([childExit(a.child), childExit(b.child)]);
    expect(a.child.signalCode).toBe("SIGTERM");
    expect(b.child.signalCode).toBe("SIGTERM");
    expect(c.child.signalCode).toBeNull();
    await restored.retireAgent(f);
  },
);

for (const fault of [
  "missing birth identity",
  "wrong birth identity",
  "wrong private token",
] as const) {
  test.skipIf(!supported)(`retirement refuses ${fault} without signaling the fixture`, async () => {
    const f = await retirementFixture();
    const token = randomUUID();
    const root = await server({ TIDY_THREAD_OWNER: token });
    const identity = await inspectProcessIdentity(root.child.pid!);
    await f.state.write("thread-port-owners", [
      {
        token: fault === "wrong private token" ? randomUUID() : token,
        projectId: f.projectId,
        threadId: f.threadId,
        rootPid: root.child.pid,
        ...(fault === "missing birth identity"
          ? {}
          : {
              rootIdentity:
                fault === "wrong birth identity" ? `${root.child.pid}:different-birth` : identity,
            }),
      },
    ]);
    await expect(f.manager.retireAgent(f)).rejects.toThrow();
    expect(root.child.signalCode).toBeNull();
    expect(await inspectProcessIdentity(root.child.pid!)).toBe(identity);
  });
}

test.skipIf(!supported)(
  "an independent same-token server makes retirement refuse, without killing either process",
  async () => {
    const f = await retirementFixture();
    const registration = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
    const root = await server(registration.environment);
    const independent = await server(registration.environment);
    registration.onSpawn(root.child.pid!);
    await f.manager.flush();
    await expect(f.manager.retireAgent(f)).rejects.toThrow("unverified process");
    expect(root.child.signalCode).toBeNull();
    expect(independent.child.signalCode).toBeNull();
    // Refusal resumed the root, rather than leaving an application server frozen in SIGSTOP.
    const { stdout } = await executeFixture("/bin/ps", [
      "-p",
      String(root.child.pid),
      "-o",
      "stat=",
    ]);
    expect(stdout.trim().startsWith("T")).toBe(false);
  },
);

test.skipIf(!supported)(
  "a dead root does not authorize killing detached same-token actors",
  async () => {
    const f = await retirementFixture();
    const registration = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
    const root = await server(registration.environment);
    const detached = await server(registration.environment);
    registration.onSpawn(root.child.pid!);
    await f.manager.flush();
    root.child.kill("SIGKILL");
    await childExit(root.child);
    await expect(new ThreadPorts(f.state).retireAgent(f)).rejects.toThrow("unverified process");
    expect(detached.child.signalCode).toBeNull();
  },
);

const orphanFixtures = new Map<number, string>();
afterEach(async () => {
  for (const [pid, identity] of orphanFixtures) {
    if ((await inspectProcessIdentity(pid)) === identity) process.kill(pid, "SIGKILL");
  }
  orphanFixtures.clear();
});
for (const diskFailure of [false, true])
  test.skipIf(!supported)(
    `provider input waits for durable ownership (disk failure: ${diskFailure})`,
    async () => {
      const f = await retirementFixture();
      const registration = await f.manager.register({
        projectId: f.projectId,
        threadId: f.threadId,
      });
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const payload = join(f.directory, "provider-input");
      const transport = new HarnessTransport({
        executable: "node",
        args: [
          "-e",
          `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(${JSON.stringify(payload)},line);const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{ok:true}})+'\\n');});`,
        ],
        cwd: f.directory,
        protocol: "jsonrpc",
        env: { ...process.env, ...registration.environment },
        onSpawn: async (...args) => {
          await registration.onSpawn(...args);
          entered.resolve();
          await gate.promise;
          if (diskFailure) throw new Error("Ownership persistence failed");
        },
        onExit: registration.onExit,
      });
      const request = transport.request("user-request");
      void request.catch(() => {});
      try {
        await entered.promise;
        await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
        const saved = z
          .array(z.object({ rootPid: z.number(), rootIdentity: z.string(), groupId: z.number() }))
          .parse(await f.state.read("thread-port-owners"));
        expect(saved[0].groupId).toBe(saved[0].rootPid);
        gate.resolve();
        if (diskFailure) {
          await expect(request).rejects.toThrow("Ownership persistence failed");
          await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await request).toEqual({ ok: true });
        }
      } finally {
        gate.resolve();
        transport.close();
        await transport.done;
      }
    },
  );

test.skipIf(!supported)(
  "reparented untagged processes retain ownership records and block replacement",
  async () => {
    const f = await retirementFixture();
    const registration = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
    const root = spawn(
      "node",
      [
        "-e",
        `const {spawn}=require('node:child_process');const env={...process.env};delete env.TIDY_THREAD_OWNER;const child=spawn(process.execPath,['-e','process.send(process.pid);setInterval(()=>{},1000)'],{env,stdio:['ignore','ignore','ignore','ipc']});child.once('message',pid=>process.send({child:pid}));process.on('message',()=>process.exit(0));`,
      ],
      {
        detached: true,
        env: { ...process.env, ...registration.environment },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(root);
    const ready = z.object({ child: z.number() }).parse(await fixtureMessage(root));
    await rememberFixture(ready.child);
    await registration.onSpawn(root.pid!, false, root.pid);
    root.send("exit");
    await childExit(root);
    // Force a new ownership scan as a fresh backend would do before starting another agent.
    const reopened = new ThreadPorts(f.state);
    await reopened.register({ projectId: randomUUID(), threadId: randomUUID() });
    await expect(reopened.retireAgent(f)).rejects.toThrow("process group");
    expect(await inspectProcessIdentity(ready.child)).not.toBeNull();
  },
  15_000,
);

async function rememberFixture(pid: number) {
  const identity = await inspectProcessIdentity(pid);
  if (!identity) throw new Error("Fixture exited before it was recorded.");
  orphanFixtures.set(pid, identity);
}

async function fixtureMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture did not become ready.")), 3000);
    child.once("message", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

for (const failedThawInspection of [false, true])
  test.skipIf(!supported)(
    `untagged descendants block recovery and verified roots resume on refusal (failed thaw inspection: ${failedThawInspection})`,
    async () => {
      const f = await retirementFixture();
      const registration = await f.manager.register({
        projectId: f.projectId,
        threadId: f.threadId,
      });
      const root = spawn(
        "node",
        [
          "-e",
          `
const { spawn } = require('node:child_process');
const environment = { ...process.env }; delete environment.TIDY_THREAD_OWNER;
const child = spawn(process.execPath, ['-e', "process.send(process.pid); setInterval(() => {}, 1000);"], {env:environment, stdio:['ignore','ignore','ignore','ipc']});
child.once('message', pid => {
  process.send({child:pid});
  setInterval(() => { if (process.connected) process.send({tick:true}); }, 250);
});
`,
        ],
        {
          env: { ...process.env, ...registration.environment },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(root);
      const ready = z.object({ child: z.number() }).parse(await fixtureMessage(root));
      await rememberFixture(ready.child);
      registration.onSpawn(root.pid!);
      await f.manager.flush();
      const originalSignal = Reflect.get(f.manager, "signalRetiredAgent").bind(f.manager) as (
        entry: OwnedProcess,
        signal: NodeJS.Signals,
      ) => Promise<boolean>;
      const thaw = failedThawInspection
        ? spyOn(
            f.manager as unknown as { signalRetiredAgent: typeof originalSignal },
            "signalRetiredAgent",
          ).mockImplementation((entry, signal) => {
            if (signal === "SIGCONT")
              return Promise.reject(new Error("Temporary ownership inspection failure"));
            return originalSignal(entry, signal);
          })
        : undefined;
      try {
        await expect(f.manager.retireAgent(f)).rejects.toThrow("descendant ownership");
        const tick = z.object({ tick: z.literal(true) }).parse(await fixtureMessage(root));
        expect(tick.tick).toBe(true);
      } finally {
        thaw?.mockRestore();
      }
      expect(root.signalCode).toBeNull();
      expect(await inspectProcessIdentity(ready.child)).not.toBeNull();
    },
    15000,
  );

test.skipIf(!supported)(
  "crashed launcher recovery retires an unsupervised orphan and its detached worker, escalating to SIGKILL",
  async () => {
    const f = await retirementFixture();
    const registration = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
    const signals = join(f.directory, "signals.txt");
    const workerFile = join(f.directory, "worker.cjs");
    const agentFile = join(f.directory, "agent.cjs");
    await writeFile(
      workerFile,
      `
process.on('SIGTERM', () => require('node:fs').appendFileSync(${JSON.stringify(signals)}, 'worker\\n'));
require('node:net').createServer().listen(0, '127.0.0.1', () => process.send({worker:process.pid}));
`,
    );
    await writeFile(
      agentFile,
      `
const worker = require('node:child_process').spawn(process.execPath, [${JSON.stringify(workerFile)}], {detached:true, stdio:['ignore','ignore','ignore','ipc']});
worker.once('message', value => { process.send({root:process.pid,...value}); worker.disconnect(); worker.unref(); });
process.on('SIGTERM', () => require('node:fs').appendFileSync(${JSON.stringify(signals)}, 'root\\n'));
setInterval(() => {}, 1000);
`,
    );
    const launcher = spawn(
      "node",
      [
        "-e",
        `
const agent = require('node:child_process').spawn(process.execPath, [${JSON.stringify(agentFile)}], {detached:true, stdio:['ignore','ignore','ignore','ipc']});
agent.once('message', value => process.send(value));
setInterval(() => {}, 1000);
`,
      ],
      {
        env: { ...process.env, ...registration.environment },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(launcher);
    const ready = z
      .object({ root: z.number(), worker: z.number() })
      .parse(await fixtureMessage(launcher));
    await rememberFixture(ready.root);
    await rememberFixture(ready.worker);
    registration.onSpawn(ready.root, false);
    await f.manager.flush();
    launcher.kill("SIGKILL");
    await childExit(launcher);
    const orphan = await inspectOwnedProcess(
      ready.root,
      new Set([registration.environment.TIDY_THREAD_OWNER]),
    );
    expect(orphan?.parentPid).not.toBe(launcher.pid);
    expect(orphan?.identity).toBe(orphanFixtures.get(ready.root));
    const restored = new ThreadPorts(new PrivateState(f.directory));
    await restored.retireAgent(f);
    expect(await inspectProcessIdentity(ready.root)).toBeNull();
    expect(await inspectProcessIdentity(ready.worker)).toBeNull();
    expect((await readFile(signals, "utf8")).trim().split("\n").sort()).toEqual(["root", "worker"]);
  },
  20000,
);

test.skipIf(!supported)(
  "an empty ownership registry after cleanup has no agent to retire",
  async () => {
    await new ThreadPorts().retireAgent({ projectId: randomUUID(), threadId: randomUUID() });
  },
);

test("unsupported platforms refuse agent retirement", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    await expect(
      new ThreadPorts().retireAgent({ projectId: randomUUID(), threadId: randomUUID() }),
    ).rejects.toThrow("not supported");
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test.skipIf(!supported)(
  "a reused root PID does not authorize signaling an unrelated fixture",
  async () => {
    const f = await retirementFixture();
    const replacement = await server();
    const identity = await inspectProcessIdentity(replacement.child.pid!);
    await f.state.write("thread-port-owners", [
      {
        token: randomUUID(),
        projectId: f.projectId,
        threadId: f.threadId,
        rootPid: replacement.child.pid,
        rootIdentity: `${replacement.child.pid}:old-birth`,
      },
    ]);
    await f.manager.retireAgent(f);
    expect(replacement.child.signalCode).toBeNull();
    expect(await inspectProcessIdentity(replacement.child.pid!)).toBe(identity);
  },
);

test.skipIf(!supported)(
  "binding a warm registration cannot overwrite queued birth-identity persistence",
  async () => {
    const f = await retirementFixture();
    const registration = await f.manager.register({ projectId: f.projectId, threadId: null });
    const root = await server(registration.environment);
    registration.onSpawn(root.child.pid!);
    await registration.bind(f.threadId);
    await f.manager.flush();
    const owners = z
      .array(z.object({ threadId: z.string(), rootIdentity: z.string() }))
      .parse(await f.state.read("thread-port-owners"));
    expect(owners[0]).toEqual({
      threadId: f.threadId,
      rootIdentity: (await inspectProcessIdentity(root.child.pid!))!,
    });
    await new ThreadPorts(f.state).retireAgent(f);
    await childExit(root.child);
    expect(root.child.signalCode).toBe("SIGTERM");
  },
);

test.skipIf(!supported)("retirement fences registrations already waiting for a prune", async () => {
  const f = await retirementFixture();
  const registration = await f.manager.register({ projectId: f.projectId, threadId: f.threadId });
  const root = await server(registration.environment);
  registration.onSpawn(root.child.pid!);
  await f.manager.flush();
  const registering = f.manager.register({ projectId: f.projectId, threadId: f.threadId });
  await Promise.resolve();
  const retiring = f.manager.retireAgent(f);
  await expect(registering).rejects.toThrow("being retired");
  await retiring;
  await childExit(root.child);
  expect(root.child.signalCode).toBe("SIGTERM");
});
