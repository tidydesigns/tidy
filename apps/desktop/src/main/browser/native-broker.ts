import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { writePrivateJSON } from "../remote/session-store";
import { nativeBrowserDescriptor } from "./native-connection";
import type { NativeBrowserRuntime } from "./native-runtime";

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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  await writePrivateJSON(nativeBrowserDescriptor(directory), {
    pid: process.pid,
    socket: path,
    token,
  });
  return async () => {
    closing = true;
    await rm(nativeBrowserDescriptor(directory), { force: true });
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path, { force: true });
    await runtime.close();
  };
}
