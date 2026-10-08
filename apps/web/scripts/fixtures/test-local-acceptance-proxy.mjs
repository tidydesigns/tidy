// Exercise Node's actual HTTP transport, as used by the browser acceptance CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { localAcceptanceProxy } from "./local-acceptance-proxy.mjs";

async function fixture(t) {
  const received = [];
  const upstream = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    received.push({
      path: incoming.url,
      method: incoming.method,
      host: incoming.headers.host,
      origin: incoming.headers.origin,
      body: Buffer.concat(chunks).toString(),
    });
    outgoing.end("upstream");
  });
  upstream.on("upgrade", (incoming, socket) => {
    received.push({ path: incoming.url, method: "upgrade", host: incoming.headers.host });
    socket.on("error", () => socket.destroy());
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await localAcceptanceProxy("http://127.0.0.1:0", target);
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { received, proxy, target };
}

function send(url, path, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, headers: { connection: "close" }, ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

function upgrade(url, path) {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, headers: { connection: "Upgrade", upgrade: "websocket" } });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(true);
    });
    req.on("error", (error) => {
      if (error.code === "ECONNRESET") resolve(false);
      else reject(error);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(false);
    });
    req.setTimeout(2000, () => req.destroy(new Error("Upgrade timed out")));
    req.end();
  });
}

test("acceptance proxy preserves paths, bodies, headers and request gates", async (t) => {
  const { received, proxy, target } = await fixture(t);
  const gate = proxy.holdNext("/save", "request");
  const response = send(
    proxy.url,
    "/save?next=%2F%2Fexample.test",
    { method: "POST", headers: { origin: proxy.url, connection: "close" } },
    "document",
  );
  await gate.reached;
  assert.equal(received.length, 0);
  gate.release();
  assert.deepEqual(await response, { status: 200, body: "upstream" });
  assert.deepEqual(received, [
    {
      path: "/save?next=%2F%2Fexample.test",
      method: "POST",
      host: new URL(target).host,
      origin: target,
      body: "document",
    },
  ]);
});

test("acceptance proxy retains the response gate after upstream completion", async (t) => {
  const { received, proxy } = await fixture(t);
  const gate = proxy.holdNext("/save");
  let completed = false;
  const response = send(proxy.url, "/save", { method: "POST" }).then((result) => {
    completed = true;
    return result;
  });
  await gate.reached;
  assert.equal(received.length, 1);
  assert.equal(completed, false);
  gate.release();
  assert.equal((await response).status, 200);
});

test("acceptance proxy rejects authority-changing HTTP paths", async (t) => {
  const { received, proxy } = await fixture(t);
  for (const path of ["//example.test/path", "/\\example.test/path", "http://example.test/path"]) {
    assert.equal((await send(proxy.url, path)).status, 400);
  }
  assert.equal(received.length, 0);
  assert.equal((await send(proxy.url, "/%5Cexample.test/path")).status, 200);
  assert.equal(received[0].path, "/%5Cexample.test/path");
});

test("acceptance proxy pins upgrade traffic to the same upstream", async (t) => {
  const { received, proxy, target } = await fixture(t);
  for (const path of ["//example.test/socket", "/\\example.test/socket"])
    assert.equal(await upgrade(proxy.url, path), false);
  assert.equal(received.length, 0);
  assert.equal(await upgrade(proxy.url, "/socket?channel=test"), true);
  assert.deepEqual(received, [
    { path: "/socket?channel=test", method: "upgrade", host: new URL(target).host },
  ]);
});

test("acceptance proxy rejects nonlocal configuration", async () => {
  for (const target of [
    "https://localhost:3000",
    "http://localhost.example.test",
    "http://example.test",
  ])
    await assert.rejects(
      localAcceptanceProxy("http://127.0.0.1:0", target),
      /localhost HTTP origins/,
    );
  for (const base of ["https://localhost:3000", "http://example.test"])
    await assert.rejects(
      localAcceptanceProxy(base, "http://127.0.0.1:3000"),
      /localhost HTTP origins/,
    );
});
