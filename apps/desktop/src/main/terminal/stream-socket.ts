import { WebSocket } from "ws";
import {
  terminalInputSchema,
  type TerminalScope,
  type TerminalWatch,
} from "../../shared/contracts/terminal";
import type { TerminalService } from "./terminal-service";

export async function serveTerminalStream({
  socket,
  terminal,
  scope,
  authorized,
}: {
  socket: WebSocket;
  terminal: TerminalService;
  scope: TerminalScope;
  authorized(): Promise<boolean>;
}) {
  let watch: TerminalWatch | undefined;
  let closed = false;
  let alive = true;
  let inputs = Promise.resolve();
  let writes = Promise.resolve();
  let pendingBytes = 0;
  let pendingInputs = 0;
  let queuedBytes = 0;
  const attached = Promise.withResolvers<void>();
  const stop = () => {
    if (closed) return;
    closed = true;
    attached.resolve();
    watch?.close();
    clearInterval(heartbeat);
    socket.terminate();
  };
  const heartbeat = setInterval(() => {
    void authorized()
      .then((valid) => {
        if (!valid || !alive) stop();
        else if (!closed) {
          alive = false;
          socket.ping();
        }
      })
      .catch(stop);
  }, 15000);
  heartbeat.unref();
  socket.on("pong", () => {
    alive = true;
  });
  socket.once("close", stop);
  socket.on("error", stop);
  socket.on("message", (data, binary) => {
    const bytes = Buffer.byteLength(data.toString());
    if (binary || bytes > 128 * 1024 || pendingBytes + bytes > 256 * 1024 || pendingInputs >= 64) {
      stop();
      return;
    }
    try {
      const input = terminalInputSchema.parse(JSON.parse(data.toString()));
      pendingBytes += bytes;
      pendingInputs++;
      inputs = inputs
        .then(async () => {
          await attached.promise;
          if (closed) return;
          if (!(await authorized())) stop();
          else if (!closed) watch?.input(input);
        })
        .catch(stop)
        .finally(() => {
          pendingBytes -= bytes;
          pendingInputs--;
        });
    } catch {
      stop();
    }
  });
  try {
    if (!(await authorized()) || closed) {
      stop();
      return;
    }
    watch = await terminal.watch(
      scope,
      (output) => {
        const data = JSON.stringify(output);
        const bytes = Buffer.byteLength(data);
        if (queuedBytes + socket.bufferedAmount + bytes > 4 * 1024 * 1024) {
          stop();
          return;
        }
        queuedBytes += bytes;
        writes = writes
          .then(async () => {
            try {
              if (closed) return;
              if (!(await authorized())) {
                stop();
                return;
              }
              if (!closed && socket.readyState === WebSocket.OPEN) socket.send(data);
            } finally {
              queuedBytes -= bytes;
            }
          })
          .catch(stop);
      },
      () => !closed,
    );
    attached.resolve();
    if (closed) watch.close();
  } catch (error) {
    if (!closed && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          kind: "error",
          message: error instanceof Error ? error.message : "Terminal unavailable.",
        }),
      );
      socket.close(1011, "Terminal unavailable");
    }
    attached.resolve();
    watch?.close();
    clearInterval(heartbeat);
  }
}
