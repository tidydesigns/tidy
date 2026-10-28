import { harnessEnvironment } from "./harnesses";
import { HarnessTransport, type ProtocolMessage } from "./harness-transport";
import type { HarnessId } from "../../shared/contracts/desktop";

type Connection = {
  transport: HarnessTransport;
  users: number;
  initialization?: Promise<unknown>;
  session?: Promise<unknown>;
  listeners: Set<(message: ProtocolMessage) => void>;
  timer: ReturnType<typeof setTimeout>;
};
const connections = new Map<string, Connection>();
export async function withHarnessConnection<T>(
  input: { executable: string; harness: HarnessId; cwd: string },
  use: (request: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
  onMessage?: (message: ProtocolMessage) => void,
): Promise<T> {
  const key = JSON.stringify([input.executable, input.harness, input.cwd]);
  let connection = connections.get(key);
  if (!connection || !connection.transport.available) {
    const transport = new HarnessTransport({
      ...input,
      env: harnessEnvironment(input.harness),
      protocol: input.harness === "claude" ? "claude" : "jsonrpc",
      args:
        input.harness === "codex"
          ? ["app-server", "--listen", "stdio://"]
          : input.harness === "opencode"
            ? ["acp", "--cwd", input.cwd]
            : [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "dontAsk",
              ],
    });
    const listeners = new Set<(message: ProtocolMessage) => void>();
    transport.onMessage = (message) => {
      if (message.id !== undefined || message.type === "control_request")
        transport.reject(
          message.id ?? message.request_id,
          "No tools are allowed during capability discovery.",
        );
      else for (const listener of listeners) listener(message);
    };
    connection = {
      transport,
      users: 0,
      listeners,
      timer: setTimeout(() => transport.close(), 15_000),
    };
    connections.set(key, connection);
  }
  const active = connection;
  active.users++;
  if (onMessage) active.listeners.add(onMessage);
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (method === "initialize")
      return (active.initialization ??= active.transport.request(method, params).then((result) => {
        if (input.harness === "codex") active.transport.notify("initialized", {});
        return result;
      }));
    if (input.harness === "opencode" && method === "session/new")
      return (active.session ??= active.transport.request(method, params));
    return active.transport.request(method, params);
  };
  try {
    return await use(request);
  } finally {
    if (onMessage) active.listeners.delete(onMessage);
    if (--active.users === 0) {
      if (connections.get(key) === active) connections.delete(key);
      clearTimeout(active.timer);
      active.transport.close();
      await active.transport.done;
    }
  }
}
