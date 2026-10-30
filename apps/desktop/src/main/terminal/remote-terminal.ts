import { WebSocket } from "ws";
import { z } from "zod";
import {
  terminalOutputSchema,
  type TerminalScope,
  type TerminalOutput,
  type TerminalWatch,
} from "../../shared/contracts/terminal";
import type { PreparedHost } from "../../shared/remote";

/** Terminal bytes use a transient authenticated stream, never durable request receipts. */
export function remoteTerminal(
  scope: TerminalScope,
  receive: (event: TerminalOutput) => void,
  options: {
    connection(): { origin: string; host: PreparedHost } | undefined;
    subscribe(listener: () => void): () => void;
  },
): TerminalWatch {
  let closed = false;
  let generation = 0;
  let connection: ReturnType<typeof options.connection>;
  let socket: WebSocket | undefined;
  let opening: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let resume = scope.resume;
  const connect = () => {
    if (closed) return;
    const next = options.connection();
    if (connection && next === connection) return;
    connection = next;
    const version = ++generation;
    opening?.abort();
    socket?.terminate();
    socket = undefined;
    if (!next) {
      receive({ kind: "disconnected", message: "Waiting for the machine…" });
      return;
    }
    const attempt = new AbortController();
    opening = attempt;
    void (async () => {
      const health = await fetch(`${next.origin}/health`, {
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]),
        redirect: "error",
      });
      const capabilities = z
        .object({ capabilities: z.array(z.string()).optional() })
        .parse(await health.json()).capabilities;
      if (closed || generation !== version) return;
      if (!capabilities?.includes("terminal-v1")) {
        receive({
          kind: "error",
          message:
            "Update Tidy's backend on this machine to use terminals. Finish active work and reconnect the machine.",
        });
        return;
      }
      const response = await fetch(`${next.origin}/auth/ticket`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${next.host.token}`,
          "X-Tidy-Client": next.host.clientId,
        },
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error("Terminal authentication expired. Reconnect the machine.");
      const { ticket } = z
        .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(await response.json());
      if (closed || generation !== version) return;
      const params = new URLSearchParams({ ticket, scope: JSON.stringify({ ...scope, resume }) });
      const client = new WebSocket(
        `${next.origin.replace("http:", "ws:")}/terminal-stream?${params}`,
        { maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15000 },
      );
      socket = client;
      let lastReceived = performance.now();
      const heartbeat = setInterval(() => {
        if (performance.now() - lastReceived > 45000) client.terminate();
      }, 15000);
      heartbeat.unref();
      client.on("ping", () => {
        lastReceived = performance.now();
      });
      client.on("message", (data, binary) => {
        if (closed || generation !== version) return;
        lastReceived = performance.now();
        if (binary) {
          client.terminate();
          return;
        }
        try {
          receive(terminalOutputSchema.parse(JSON.parse(data.toString())));
        } catch {
          client.terminate();
        }
      });
      client.once("error", () => client.terminate());
      client.once("close", () => {
        clearInterval(heartbeat);
        if (closed || generation !== version) return;
        connection = undefined;
        socket = undefined;
        receive({ kind: "disconnected", message: "Reconnecting to the terminal…" });
        clearTimeout(retry);
        retry = setTimeout(connect, 1500);
      });
    })().catch(() => {
      if (closed || generation !== version) return;
      connection = undefined;
      receive({ kind: "disconnected", message: "Reconnecting to the terminal…" });
      clearTimeout(retry);
      retry = setTimeout(connect, 3000);
    });
  };
  const unsubscribe = options.subscribe(connect);
  connect();
  return {
    input(input) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 256 * 1024) {
        socket.terminate();
        return;
      }
      if (input.kind === "ack") resume = { sessionId: input.sessionId, sequence: input.sequence };
      socket.send(JSON.stringify(input));
    },
    close() {
      closed = true;
      generation++;
      opening?.abort();
      clearTimeout(retry);
      unsubscribe();
      socket?.terminate();
    },
  };
}
