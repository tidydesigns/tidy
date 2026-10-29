import { encodeBrowserFrame } from "./frame-codec";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  browserInputEnvelopeSchema,
  type BrowserScope,
  type BrowserWatch,
} from "../../shared/contracts/browser";
import type { BrowserService } from "./browser-service";

export async function serveBrowserStream({
  socket,
  browser,
  scope,
  authorized,
  viewerId,
}: {
  socket: WebSocket;
  browser: BrowserService;
  scope: BrowserScope;
  viewerId?: string;
  authorized(): Promise<boolean>;
}) {
  let watch: BrowserWatch | undefined;
  let closed = false;
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  let writes = Promise.resolve();
  let inputs = Promise.resolve();
  let pendingInputs = 0;
  const attached = Promise.withResolvers<void>();
  let queuedBytes = 0;
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
  socket.once("close", stop);
  socket.on("error", stop);
  socket.on("message", (data, binary) => {
    if (binary || Buffer.byteLength(data.toString()) > 128 * 1024 || pendingInputs >= 64) {
      stop();
      return;
    }
    try {
      const input = browserInputEnvelopeSchema.parse(JSON.parse(data.toString()));
      pendingInputs++;
      inputs = inputs
        .then(async () => {
          await attached.promise;
          if (closed) return;
          const valid = await authorized();
          if (!valid) stop();
          else if (!closed) watch?.input(input);
        })
        .catch(stop)
        .finally(() => {
          pendingInputs--;
        });
    } catch {
      stop();
    }
  });
  try {
    watch = await browser.watch(scope, viewerId ?? randomUUID(), (event) => {
      const data = event.kind === "frame" ? encodeBrowserFrame(event) : JSON.stringify(event);
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
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
    });
    attached.resolve();
    if (closed) watch.close();
  } catch (error) {
    if (!closed && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          kind: "error",
          message: error instanceof Error ? error.message : "The browser is unavailable.",
        }),
      );
      socket.close(1011, "Browser unavailable");
    }
    stop();
  }
}
