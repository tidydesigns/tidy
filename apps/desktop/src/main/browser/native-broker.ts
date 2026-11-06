import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import { writePrivateJSON } from "../remote/session-store";
import { nativeBrowserDescriptor } from "./native-connection";
import type { NativeBrowserRuntime } from "./native-runtime";

/** Publish a private broker, rolling back transport and descriptor state if setup fails. */
export async function serveNativeBrowser(runtime: NativeBrowserRuntime, directory: string) {
  const path = `/tmp/tidy-native-${randomUUID()}.sock`;
  const token = randomBytes(32).toString("hex");
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
    perMessageDeflate: false,
  });
  let closing = false;
  let resetting = false;
  let listening = false;
  let cleanup: Promise<void> | undefined;
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const clearDescriptor = async () => {
    try {
      await rm(nativeBrowserDescriptor(directory), { force: true });
    } catch (error) {
      // A surviving host must stop retrying a dead socket even if unlink fails.
      try {
        await writePrivateJSON(nativeBrowserDescriptor(directory), {});
      } catch (invalidationError) {
        throw new AggregateError(
          [error, invalidationError],
          "Could not clear native browser descriptor.",
        );
      }
    }
  };
  const close = () => {
    closing = true;
    return (cleanup ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      // Stop accepting connections before asynchronous descriptor cleanup.
      const stopped = attempt(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING"))
                reject(error);
              else resolve();
            });
          }),
      );
      await attempt(clearDescriptor);
      runtime.onmessage = undefined;
      runtime.onclose = undefined;
      for (const client of sockets.clients) await attempt(() => client.terminate());
      for (const socket of connections) await attempt(() => socket.destroy());
      await attempt(
        () =>
          new Promise<void>((resolve, reject) => {
            sockets.close((error) => (error ? reject(error) : resolve()));
          }),
      );
      await stopped;
      if (listening) await attempt(() => rm(path, { force: true }));
      await attempt(() => runtime.close());
      if (errors.length)
        throw new AggregateError(errors, "Could not fully close native browser broker.");
    })());
  };
  server.on("upgrade", (request, socket, head) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      closing ||
      resetting ||
      request.url !== "/cdp" ||
      request.headers.origin ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied) ||
      sockets.clients.size
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      runtime.onmessage = (message) => {
        if (client.readyState === client.OPEN) client.send(message);
      };
      runtime.onclose = () => client.close();
      client.on("message", (data, binary) => {
        if (binary) {
          client.close(1008);
          return;
        }
        try {
          runtime.send(data.toString());
        } catch {
          client.close(1008);
        }
      });
      client.on("error", () => client.terminate());
      client.once("close", () => {
        runtime.onmessage = undefined;
        runtime.onclose = undefined;
        if (!closing) {
          resetting = true;
          void runtime
            .reset()
            .finally(() => {
              resetting = false;
            })
            .catch(() => {});
        }
      });
    });
  });
  try {
    // Remove the previous app's descriptor before any setup step can fail.
    await clearDescriptor();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        listening = true;
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    await writePrivateJSON(nativeBrowserDescriptor(directory), {
      pid: process.pid,
      socket: path,
      token,
    });
    return close;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Native browser broker setup and cleanup failed.",
      );
    }
    throw error;
  }
}
