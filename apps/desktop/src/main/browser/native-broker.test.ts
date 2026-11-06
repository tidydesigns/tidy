import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Server } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sessionStore from "../remote/session-store";
import { connectNativeBrowser, nativeBrowserDescriptor } from "./native-connection";
import { serveNativeBrowser } from "./native-broker";
import type { NativeBrowserRuntime } from "./native-runtime";

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  mock.restore();
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function runNode(source: string) {
  const result = spawnSync(
    "node",
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", source],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || "Node broker test failed");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-broker-"));
  roots.push(directory);
  const runtime = {
    close: mock(async () => {}),
    reset: mock(async () => {}),
    send: mock(() => {}),
    onmessage: undefined,
    onclose: undefined,
  };
  return {
    directory,
    descriptor: nativeBrowserDescriptor(directory),
    runtime,
    serve: () => serveNativeBrowser(runtime as unknown as NativeBrowserRuntime, directory),
  };
}

async function staleDescriptor(path: string) {
  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      socket: "/tmp/tidy-native-00000000-0000-0000-0000-000000000000.sock",
      token: "a".repeat(64),
    }),
    { mode: 0o600 },
  );
}

async function absent(path: string) {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

test("listen failure clears a live-PID stale descriptor and closes the runtime", async () => {
  const f = await fixture();
  await staleDescriptor(f.descriptor);
  spyOn(Server.prototype, "listen").mockImplementationOnce(function (this: Server) {
    queueMicrotask(() => this.emit("error", new Error("listen failed")));
    return this;
  });
  await expect(f.serve()).rejects.toThrow("listen failed");
  await absent(f.descriptor);
  expect(await connectNativeBrowser(f.directory)).toBeUndefined();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test("chmod failure closes the listening server and removes its socket and stale descriptor", async () => {
  const f = await fixture();
  await staleDescriptor(f.descriptor);
  const permissions = spyOn(filesystem, "chmod").mockRejectedValueOnce(new Error("chmod failed"));
  await expect(f.serve()).rejects.toThrow("chmod failed");
  await absent(String(permissions.mock.calls[0]![0]));
  await absent(f.descriptor);
  expect(await connectNativeBrowser(f.directory)).toBeUndefined();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test("descriptor publication failure cleans up even if the descriptor was already written", async () => {
  const f = await fixture();
  const write = sessionStore.writePrivateJSON;
  const permissions = spyOn(filesystem, "chmod");
  spyOn(sessionStore, "writePrivateJSON").mockImplementationOnce(async (path, value) => {
    await write(path, value);
    throw new Error("publication failed");
  });
  await expect(f.serve()).rejects.toThrow("publication failed");
  await absent(String(permissions.mock.calls[0]![0]));
  await absent(f.descriptor);
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test("setup reports its original error and cleanup failure after removing transport resources", async () => {
  const f = await fixture();
  const permissions = spyOn(filesystem, "chmod").mockRejectedValueOnce(new Error("chmod failed"));
  f.runtime.close.mockRejectedValueOnce(new Error("runtime close failed"));
  let failure: unknown;
  try {
    await f.serve();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toMatchObject({ message: "chmod failed" });
  expect((failure as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
  await absent(String(permissions.mock.calls[0]![0]));
  await absent(f.descriptor);
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test("Node broker retains permissions/authenticated reconnect and closes active and idle connections once", async () => {
  const f = await fixture();
  // Electron uses Node's HTTP/ws implementation. Bun's shims do not support the
  // same Unix-socket upgrade/connection lifecycle, so exercise transport in Node.
  const source = `
    import assert from "node:assert/strict";
    import { readFile, stat } from "node:fs/promises";
    import { createRequire } from "node:module";
    import { connect } from "node:net";
    import { serveNativeBrowser } from ${JSON.stringify(new URL("./native-broker.ts", import.meta.url).href)};
    const require = createRequire(${JSON.stringify(import.meta.url)});
    const { WebSocket } = require("ws");
    let closes = 0, resets = 0, resetDone;
    const reset = new Promise(resolve => { resetDone = resolve; });
    const runtime = { close: async () => { closes++; }, reset: async () => { resets++; resetDone(); }, send() {} };
    const close = await serveNativeBrowser(runtime, ${JSON.stringify(f.directory)});
    try {
      const path = ${JSON.stringify(f.descriptor)};
      const descriptor = JSON.parse(await readFile(path, "utf8"));
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(descriptor.socket)).mode & 0o777, 0o600);
      const url = "ws+unix://" + descriptor.socket + ":/cdp";
      const unauthorized = new WebSocket(url);
      await new Promise(resolve => unauthorized.once("error", resolve));
      let client = new WebSocket(url, { headers: { Authorization: "Bearer " + descriptor.token } });
      await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      const disconnected = new Promise(resolve => client.once("close", resolve));
      client.close();
      await Promise.all([disconnected, reset]);
      await new Promise(resolve => setImmediate(resolve));
      client = new WebSocket(url, { headers: { Authorization: "Bearer " + descriptor.token } });
      await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      const idle = connect(descriptor.socket);
      await new Promise((resolve, reject) => { idle.once("connect", resolve); idle.once("error", reject); });
      const clientClosed = new Promise(resolve => client.once("close", resolve));
      const idleClosed = new Promise(resolve => idle.once("close", resolve));
      const closing = close();
      assert.equal(close(), closing);
      await closing;
      await Promise.all([clientClosed, idleClosed]);
      await close();
      await assert.rejects(stat(path), { code: "ENOENT" });
      await assert.rejects(stat(descriptor.socket), { code: "ENOENT" });
      assert.equal(closes, 1);
      assert.equal(resets, 1);
    } finally { await close(); }
  `;
  runNode(source);
});

test("unlink failure invalidates the descriptor so a surviving host can stream", async () => {
  const f = await fixture();
  const close = await f.serve();
  closers.push(close);
  const remove = filesystem.rm;
  spyOn(filesystem, "rm").mockImplementation((path, options) => {
    if (path === f.descriptor) return Promise.reject(new Error("unlink failed"));
    return remove(path, options);
  });
  await close();
  expect(JSON.parse(await readFile(f.descriptor, "utf8"))).toEqual({});
  expect((await stat(f.descriptor)).mode & 0o777).toBe(0o600);
  expect(await connectNativeBrowser(f.directory)).toBeUndefined();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test("cleanup still closes transport and runtime when descriptor removal and invalidation fail", async () => {
  const f = await fixture();
  const close = await f.serve();
  closers.push(close);
  const descriptor = JSON.parse(await readFile(f.descriptor, "utf8"));
  const remove = filesystem.rm;
  spyOn(filesystem, "rm").mockImplementation((path, options) => {
    if (path === f.descriptor) return Promise.reject(new Error("unlink failed"));
    return remove(path, options);
  });
  spyOn(sessionStore, "writePrivateJSON").mockRejectedValue(new Error("invalidation failed"));
  f.runtime.close.mockRejectedValue(new Error("runtime close failed"));
  const closing = close();
  expect(close()).toBe(closing);
  await expect(closing).rejects.toBeInstanceOf(AggregateError);
  await absent(descriptor.socket);
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
  await expect(close()).rejects.toBeInstanceOf(AggregateError);
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
  runNode(`
    import assert from "node:assert/strict";
    import { connectNativeBrowser } from ${JSON.stringify(new URL("./native-connection.ts", import.meta.url).href)};
    assert.equal(await connectNativeBrowser(${JSON.stringify(f.directory)}), undefined);
  `);
});

test("Node connection falls back for ENOENT and ECONNREFUSED despite a valid live-PID descriptor", async () => {
  const f = await fixture();
  runNode(`
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { writeFile, readFile, rm } from "node:fs/promises";
    import { spawnSync } from "node:child_process";
    import { createRequire } from "node:module";
    import { connectNativeBrowser } from ${JSON.stringify(new URL("./native-connection.ts", import.meta.url).href)};
    const { WebSocket } = createRequire(${JSON.stringify(import.meta.url)})("ws");
    const socket = "/tmp/tidy-native-" + randomUUID() + ".sock";
    const descriptor = JSON.stringify({ pid: process.pid, socket, token: "a".repeat(64) });
    const path = ${JSON.stringify(f.descriptor)};
    await writeFile(path, descriptor, { mode: 0o600 });
    const errorCode = () => new Promise(resolve => {
      new WebSocket("ws+unix://" + socket + ":/cdp").once("error", error => resolve(error.code));
    });
    try {
      assert.equal(await errorCode(), "ENOENT");
      assert.equal(await connectNativeBrowser(${JSON.stringify(f.directory)}), undefined);
      // Exit without server.close() to leave a real Unix socket with no listener.
      const orphan = spawnSync(process.execPath, ["--input-type=module", "--eval",
        'import { createServer } from "node:net"; createServer().listen(' + JSON.stringify(socket) + ', () => process.exit(0));'
      ], { encoding: "utf8", timeout: 2000 });
      assert.equal(orphan.status, 0, orphan.stderr);
      assert.equal(await errorCode(), "ECONNREFUSED");
      assert.equal(await connectNativeBrowser(${JSON.stringify(f.directory)}), undefined);
      assert.equal(await readFile(path, "utf8"), descriptor);
    } finally { await rm(socket, { force: true }); }
  `);
});

test("Node connection retains retry errors for broker reset, rejection and handshake timeout", async () => {
  const f = await fixture();
  runNode(`
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { createServer } from "node:http";
    import { writeFile, rm } from "node:fs/promises";
    import { connectNativeBrowser } from ${JSON.stringify(new URL("./native-connection.ts", import.meta.url).href)};
    const socket = "/tmp/tidy-native-" + randomUUID() + ".sock";
    const server = createServer();
    const connections = new Set();
    let mode = "reset";
    server.on("connection", connection => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
    });
    server.on("upgrade", (_request, connection) => {
      if (mode === "reset") connection.destroy();
      else if (mode === "reject") connection.end("HTTP/1.1 503 Service Unavailable\\r\\nContent-Length: 0\\r\\n\\r\\n");
      // In timeout mode, deliberately leave the handshake unanswered.
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await writeFile(${JSON.stringify(f.descriptor)}, JSON.stringify({
      pid: process.pid, socket, token: "a".repeat(64)
    }), { mode: 0o600 });
    try {
      for (const scenario of ["reset", "reject", "timeout"]) {
        mode = scenario;
        await assert.rejects(connectNativeBrowser(${JSON.stringify(f.directory)}), error => {
          assert.match(error.message, /reconnecting.*Retry shortly/);
          if (scenario === "reset") assert.equal(error.cause.code, "ECONNRESET");
          if (scenario === "reject") assert.match(error.cause.message, /503/);
          if (scenario === "timeout") assert.match(error.cause.message, /handshake.*timed out/i);
          return true;
        });
      }
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(socket, { force: true });
    }
  `);
});
