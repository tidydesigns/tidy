import { encodeBrowserFrame } from "./frame-codec";
import { BrowserInputQueue } from "./input-queue";
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
  native = false,
}: {
  socket: WebSocket;
  browser: BrowserService;
  scope: BrowserScope;
  viewerId?: string;
  native?: boolean;
  authorized(): Promise<boolean>;
}) {
  let watch: BrowserWatch | undefined;
  let closed = false;
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  let writes = Promise.resolve();
  const attached = Promise.withResolvers<void>();
  let queuedBytes = 0;
  const stop = () => {
    if (closed) return;
    closed = true;
    attached.resolve();
    inputs.clear();
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
  const inputs = new BrowserInputQueue({
    dispatch: async (input) => {
      await attached.promise;
      if (closed) return;
      if (!(await authorized())) stop();
      else if (!closed) watch?.input(input);
    },
    failed: stop,
  });
  socket.on("message", (data, binary) => {
    if (binary || Buffer.byteLength(data.toString()) > 128 * 1024) {
      stop();
      return;
    }
    try {
      const input = browserInputEnvelopeSchema.parse(JSON.parse(data.toString()));
      if (!inputs.push(input)) stop();
    } catch {
      stop();
    }
  });
  try {
    watch = await browser.watch(
      scope,
      viewerId ?? randomUUID(),
      (event) => {
        const data = event.kind === "frame" ? encodeBrowserFrame(event) : JSON.stringify(event);
        const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        // Capture allows at most 8 MiB unacknowledged per viewer; leave room for headers/state.
        if (queuedBytes + socket.bufferedAmount + bytes > 16 * 1024 * 1024) {
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
      native ? { update: () => {}, close: () => {} } : undefined,
    );
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
