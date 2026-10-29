import { createServer, request as upstreamRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { mobileOriginSchema } from "@tidy/agent-protocol/mobile";

/** Loopback-only adapter for Tailscale Serve. The existing host remains SSH-only. */
export function createMobileGateway(origin: string, backendPort: () => Promise<number>) {
  const endpoint = new URL(mobileOriginSchema.parse(origin));
  const connections = new Set<Duplex>();
  function allowed(request: IncomingMessage, upgrade: boolean) {
    if (
      request.headers.host !== endpoint.host ||
      (request.headers.origin && request.headers.origin !== endpoint.origin)
    )
      return false;
    if (upgrade)
      return request.method === "GET" && /^\/events\?ticket=[a-f0-9]{64}$/.test(request.url ?? "");
    return request.method === "POST" && request.url === "/auth/ticket";
  }
  async function forward(request: IncomingMessage) {
    const port = await backendPort();
    // Do not trust forwarded identity or allow proxying maintenance / arbitrary paths.
    return upstreamRequest({
      hostname: "127.0.0.1",
      port,
      method: request.method,
      path: request.url,
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: request.headers.authorization ?? "",
        "x-tidy-client": request.headers["x-tidy-client"] ?? "",
        "content-length": "0",
      },
      timeout: 10_000,
    });
  }
  const server = createServer((request, response) => {
    if (!allowed(request, false)) {
      response.writeHead(403).end();
      return;
    }
    void forward(request)
      .then((upstream) => {
        upstream.on("response", (result) => {
          response.writeHead(result.statusCode ?? 502, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          result.pipe(response);
        });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        response.on("close", () => upstream.destroy());
        upstream.end();
      })
      .catch(() => response.writeHead(503).end());
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if (!alive.has(client)) client.terminate();
      else {
        alive.delete(client);
        client.ping();
      }
    }
  }, 15_000);
  heartbeat.unref();
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!allowed(request, true)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    void backendPort()
      .then((port) => {
        if (socket.destroyed) return;
        const upstream = new WebSocket(`ws://127.0.0.1:${port}${request.url}`, {
          handshakeTimeout: 10_000,
          maxPayload: 32 * 1024 * 1024,
          perMessageDeflate: false,
        });
        const close = () => {
          upstream.terminate();
          socket.destroy();
        };
        socket.on("close", () => upstream.terminate());
        upstream.on("error", close);
        upstream.on("close", () => socket.destroy());
        upstream.on("open", () => {
          if (socket.destroyed) {
            upstream.terminate();
            return;
          }
          sockets.handleUpgrade(request, socket, head, (client) => {
            alive.add(client);
            client.on("pong", () => alive.add(client));
            const relay = (
              target: WebSocket,
              data: Buffer | ArrayBuffer | Buffer[],
              binary: boolean,
            ) => {
              const bytes = Array.isArray(data)
                ? data.reduce((size, part) => size + part.byteLength, 0)
                : data.byteLength;
              if (
                target.readyState !== WebSocket.OPEN ||
                target.bufferedAmount + bytes > 32 * 1024 * 1024
              ) {
                close();
                return;
              }
              target.send(data, { binary }, (error) => {
                if (error) close();
              });
            };
            upstream.on("message", (data, binary) => relay(client, data, binary));
            client.on("message", (data, binary) => relay(upstream, data, binary));
            client.on("error", close);
            client.on("close", close);
          });
        });
      })
      .catch(() => socket.destroy());
  });
  return {
    async listen(port = 4319) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Gateway did not start.");
      return address.port;
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of connections) socket.destroy();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
