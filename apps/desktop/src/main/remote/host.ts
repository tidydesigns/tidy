import { z } from "zod";
import { RequestReceipts } from "./receipts";
import { isRemoteMutation } from "../../shared/remote";
import { createServer, type IncomingMessage } from "node:http";
import { readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { remoteRequestSchema, type RemoteRequest, type PreparedHost } from "../../shared/remote";
import { createWorkspaceRequests } from "../ipc/workspace-requests";
import type { DesktopEvent } from "../../shared/contracts/desktop";
import type { WorkspaceService } from "../workspace/workspace-service";
import { SessionStore } from "./session-store";

export const MAX_REMOTE_BYTES = 32 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 30_000;
export function createRemoteHost({
  service,
  identity,
  sessions,
  shutdown,
  receipts,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
}: {
  service: WorkspaceService;
  identity: Pick<PreparedHost, "hostId" | "instanceId" | "buildId">;
  sessions: SessionStore;
  shutdown?: () => void;
  receipts: RequestReceipts;
  drainTimeoutMs?: number;
}) {
  let draining = false;
  let inflight = 0;
  let finishRequests: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const alive = new WeakSet<WebSocket>();
  const clients = new Map<
    WebSocket,
    {
      clientId: string;
      token: string;
      writes: Promise<void>;
      queuedBytes: number;
    }
  >();
  const send = (client: WebSocket, value: unknown, event?: DesktopEvent) => {
    const auth = clients.get(client);
    if (!auth || client.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(value);
    const bytes = Buffer.byteLength(data);
    if (auth.queuedBytes + client.bufferedAmount + bytes > MAX_REMOTE_BYTES) {
      client.terminate();
      return;
    }
    auth.queuedBytes += bytes;
    auth.writes = auth.writes
      .then(async () => {
        try {
          if (client.readyState !== WebSocket.OPEN || clients.get(client) !== auth) return;
          if (!(await sessions.validate(auth.clientId, auth.token))) {
            client.terminate();
            return;
          }
          if (event && !service.canDeliverEvent(event)) return;
          if (client.readyState === WebSocket.OPEN) client.send(data);
        } finally {
          auth.queuedBytes -= bytes;
        }
      })
      .catch(() => client.terminate());
  };
  const tickets = new Map<string, { clientId: string; token: string; expires: number }>();
  const requests = createWorkspaceRequests<RemoteRequest>(service, {
    chooseProject: async ({ projectPath }) => {
      if (!projectPath) throw new Error("Choose a folder on the remote machine.");
      return projectPath;
    },
    chooseDesign: async ({ file }) => file ?? null,
    showItemInFolder() {
      throw new Error("Open files on the remote machine directly.");
    },
    openExternal: async () => {
      throw new Error("Open usage from the desktop app.");
    },
  });
  const authenticated = async (request: IncomingMessage) => {
    const clientId = request.headers["x-tidy-client"];
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    return typeof clientId === "string" && token && (await sessions.validate(clientId, token))
      ? { clientId, token }
      : null;
  };
  const trusted = (request: IncomingMessage) =>
    !request.headers.origin && /^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "");
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (!trusted(request)) return send(403, { error: "Untrusted origin." });
      if (request.method === "GET" && request.url === "/health")
        return send(200, { ...identity, protocol: 3, activeRuns: service.activeRunCount });
      if (
        request.method !== "POST" ||
        !["/auth/ticket", "/maintenance/restart"].includes(request.url ?? "")
      )
        return send(404, { error: "Not found." });
      const auth = await authenticated(request);
      if (!auth) return send(401, { error: "Session expired. Reconnect over SSH." });
      if (request.url === "/maintenance/restart") {
        if (!shutdown) return send(403, { error: "This backend is managed externally." });
        if (service.activeRunCount > 0 || inflight > 0)
          return send(409, { error: "Finish active runs before updating." });
        if (!draining) {
          draining = true;
          setTimeout(shutdown, 100);
        }
        return send(200, { stopping: true });
      }
      if (draining) return send(503, { error: "Backend is restarting." });
      for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
      if (tickets.size >= 128) return send(429, { error: "Too many pending connections." });
      const ticket = randomBytes(32).toString("hex");
      tickets.set(ticket, { ...auth, expires: Date.now() + 30_000 });
      send(200, { ticket });
    })().catch(() => send(500, { error: "Remote authentication failed." }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REMOTE_BYTES,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    const key = url.searchParams.get("ticket") ?? "";
    const ticket = tickets.get(key);
    tickets.delete(key);
    if (
      draining ||
      !trusted(request) ||
      url.pathname !== "/events" ||
      !ticket ||
      ticket.expires < Date.now()
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    void sessions
      .validate(ticket.clientId, ticket.token)
      .then((valid) => {
        if (!valid) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          clients.set(client, { ...ticket, writes: Promise.resolve(), queuedBytes: 0 });
          alive.add(client);
          client.on("pong", () => alive.add(client));
          client.on("error", () => {});
          client.on("close", () => clients.delete(client));
          send(client, { type: "hello", protocol: 3, hostId: identity.hostId });
          let pending = 0;
          client.on("message", (data, binary) => {
            if (binary || ++pending > 64) {
              client.terminate();
              return;
            }
            inflight++;
            void (async () => {
              let request: RemoteRequest;
              try {
                request = remoteRequestSchema.parse(JSON.parse(data.toString()));
              } catch {
                client.terminate();
                return;
              }
              try {
                if (draining || !(await sessions.validate(ticket.clientId, ticket.token))) {
                  client.terminate();
                  return;
                }
                if (isRemoteMutation(request.name)) {
                  const response = await receipts.execute(ticket.clientId, request, () =>
                    requests.invoke(request.name, request.input, request),
                  );
                  send(client, { type: "result", id: request.id, response });
                  return;
                }
                let result: unknown;
                if (request.name === "ping") result = null;
                else if (request.name === "receipt") {
                  const id = z.string().uuid().parse(request.input);
                  result = await receipts.status(ticket.clientId, id);
                } else if (request.name === "directories") {
                  const path = await realpath(request.projectPath ?? homedir());
                  const entries = await readdir(path, { withFileTypes: true });
                  result = {
                    path,
                    parent: dirname(path) === path ? null : dirname(path),
                    initialProject: "",
                    directories: entries
                      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((entry) => ({
                        name: entry.name,
                        path: `${path.replace(/\/$/, "")}/${entry.name}`,
                      })),
                  };
                } else result = await requests.invoke(request.name, request.input, request);
                send(client, {
                  type: "result",
                  id: request.id,
                  response: { ok: true, data: result },
                });
              } catch (error) {
                send(client, {
                  type: "result",
                  id: request.id,
                  response: {
                    ok: false,
                    error: error instanceof Error ? error.message : "Remote request failed.",
                  },
                });
              }
            })().finally(() => {
              pending--;
              inflight--;
              if (inflight === 0) finishRequests?.();
            });
          });
        });
      })
      .catch(() => socket.destroy());
  });
  const unsubscribe = service.subscribeRenderer((event) => {
    for (const client of clients.keys()) send(client, { type: "event", event }, event);
  });
  const heartbeat = setInterval(() => {
    for (const [client, auth] of clients)
      void sessions.validate(auth.clientId, auth.token).then((valid) => {
        if (!valid || !alive.has(client)) client.terminate();
        else if (client.readyState === WebSocket.OPEN) {
          alive.delete(client);
          client.ping();
        }
      });
  }, 15_000);
  heartbeat.unref();
  return {
    async listen(port = 0) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No backend address.");
      receipts.start();
      return address.port;
    },
    close() {
      closing ??= (async () => {
        draining = true;
        clearInterval(heartbeat);
        unsubscribe();
        for (const client of clients.keys()) client.terminate();
        sockets.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          if (inflight > 0)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () =>
                  reject(new Error("Backend shutdown timed out waiting for accepted requests.")),
                drainTimeoutMs,
              );
              finishRequests = () => {
                clearTimeout(timer);
                resolve();
              };
            }).finally(() => {
              finishRequests = undefined;
            });
        } finally {
          await receipts.close();
        }
      })();
      return closing;
    },
  };
}
