import { createServer, request as httpRequest } from "node:http";

// Hold real traffic, never fabricate an application response or bypass its auth.
export async function localAcceptanceProxy(base, target) {
  const origin = new URL(base),
    upstream = new URL(target);
  for (const url of [origin, upstream])
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error("Acceptance proxy requires two localhost HTTP origins.");
  // Incoming paths must never determine the transport's authority.
  const upstreamOptions = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
  };
  const validPath = (value) =>
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u0020\u007f]/.test(value);
  let next;
  const gates = new Set();
  const sockets = new Set();
  const server = createServer(async (incoming, outgoing) => {
    if (!validPath(incoming.url)) {
      outgoing.writeHead(400).end();
      return;
    }
    const gate =
      incoming.method === "POST" && incoming.url.split("?")[0] === next?.path ? next : null;
    if (gate) next = null;
    if (gate?.stage === "request") {
      gate.arrive();
      await gate.wait;
    }
    const headers = { ...incoming.headers, host: upstream.host, "x-forwarded-host": upstream.host };
    if (headers.origin === origin.origin) headers.origin = upstream.origin;
    const proxy = httpRequest(
      {
        ...upstreamOptions,
        path: incoming.url,
        method: incoming.method,
        headers,
      },
      async (response) => {
        if (gate?.stage === "response") {
          gate.arrive();
          await gate.wait;
        }
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    proxy.on("error", (error) => outgoing.destroy(error));
    incoming.pipe(proxy);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  // Turbopack needs its development socket before it can finish loading chunks.
  server.on("upgrade", (incoming, socket, head) => {
    if (!validPath(incoming.url)) {
      socket.destroy();
      return;
    }
    const proxy = httpRequest({
      ...upstreamOptions,
      path: incoming.url,
      headers: { ...incoming.headers, host: upstream.host, origin: upstream.origin },
    });
    proxy.on("upgrade", (response, backend, backendHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) backend.write(head);
      if (backendHead.length) socket.write(backendHead);
      socket.pipe(backend).pipe(socket);
      socket.on("close", () => backend.destroy());
      backend.on("error", () => socket.destroy());
    });
    proxy.on("error", () => socket.destroy());
    proxy.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(origin.port), origin.hostname, resolve);
  });
  origin.port = String(server.address().port);
  return {
    url: origin.origin,
    holdNext(path, stage = "response") {
      if (next) throw new Error("An acceptance gate is already armed.");
      let arrive, release;
      const reached = new Promise((resolve) => {
        arrive = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const gate = { path, stage, arrive, wait, release };
      next = gate;
      gates.add(gate);
      return {
        reached: Promise.race([
          reached,
          new Promise((_, reject) => {
            const timeout = setTimeout(
              () => reject(new Error(`No real request reached ${path}`)),
              20_000,
            );
            timeout.unref();
          }),
        ]),
        release: () => {
          release();
          gates.delete(gate);
        },
      };
    },
    async close() {
      for (const gate of gates) gate.release();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
