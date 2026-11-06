import { readLocalFile } from "../platform/local-files";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { WebSocket } from "ws";
import { connect, type ConnectionTransport } from "puppeteer-core";

export const nativeBrowserDescriptor = (
  directory = process.env.TIDY_HOST_STATE ?? join(homedir(), ".local", "state", "tidy-host"),
) => join(directory, "native-browser.json");
export const nativeConnectionSchema = z
  .object({
    pid: z.number().int().positive(),
    socket: z.string().regex(/^\/tmp\/tidy-native-[a-f0-9-]+\.sock$/),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** A private Unix socket lets a surviving workspace host use the app's native pages. */
export async function connectNativeBrowser(directory?: string) {
  let descriptor: z.infer<typeof nativeConnectionSchema>;
  try {
    descriptor = nativeConnectionSchema.parse(
      JSON.parse(
        (
          await readLocalFile(nativeBrowserDescriptor(directory), 4096, async (info) => {
            if (info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()))
              throw new Error("Unsafe native browser descriptor.");
          })
        ).toString("utf8"),
      ),
    );
    process.kill(descriptor.pid, 0);
  } catch {
    return undefined;
  }
  const socket = new WebSocket(`ws+unix://${descriptor.socket}:/cdp`, {
    headers: { Authorization: `Bearer ${descriptor.token}` },
    handshakeTimeout: 2000,
    maxPayload: 32 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const result = await new Promise<{ opened: true } | { opened: false; error: Error }>(
    (resolve) => {
      socket.once("open", () => resolve({ opened: true }));
      socket.once("error", (error) => resolve({ opened: false, error }));
    },
  );
  if (!result.opened) {
    socket.terminate();
    // Cleanup may be unable to unlink or invalidate a live-PID descriptor.
    // A missing/refused socket has no broker; rejection and handshake timeouts
    // can be temporary while the native runtime resets and must remain retryable.
    const code = "code" in result.error ? result.error.code : undefined;
    if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
    throw new Error("The local native browser is reconnecting. Retry shortly.", {
      cause: result.error,
    });
  }
  const transport: ConnectionTransport = {
    send: (message) => socket.send(message),
    close: () => socket.close(),
  };
  socket.on("message", (data) => transport.onmessage?.(data.toString()));
  socket.on("close", () => transport.onclose?.());
  return connect({ transport, defaultViewport: null });
}
