import { nativeSessionIdSchema } from "../../shared/contracts/desktop";
import { acpCommandsSchema, acpInitializationSchema } from "./opencode-adapter";
import { harnessEnvironment } from "./harnesses";
import {
  object,
  HarnessRequestError,
  HarnessTransport,
  type ProtocolMessage,
} from "./harness-transport";
import type { HarnessId } from "../../shared/contracts/desktop";

type Connection = {
  transport: HarnessTransport;
  users: number;
  initialization?: Promise<unknown>;
  session?: Promise<unknown>;
  sessionId?: string;
  deleteSession: boolean;
  loadSession: boolean;
  commands?: ProtocolMessage;
  listeners: Set<(message: ProtocolMessage) => void>;
  timer: ReturnType<typeof setTimeout>;
};
const connections = new Map<string, Connection>();
const discoverySessions = new Map<string, string>();
function rememberSession(key: string, sessionId: string) {
  discoverySessions.delete(key);
  discoverySessions.set(key, sessionId);
  if (discoverySessions.size > 64) {
    const oldest = discoverySessions.keys().next();
    if (!oldest.done) discoverySessions.delete(oldest.value);
  }
}
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
    const active: Connection = {
      transport,
      users: 0,
      listeners,
      deleteSession: false,
      loadSession: false,
      timer: setTimeout(() => transport.close(), 15_000),
    };
    transport.onMessage = (message) => {
      if (message.id !== undefined || message.type === "control_request")
        transport.reject(
          message.id ?? message.request_id,
          "No tools are allowed during capability discovery.",
        );
      else {
        if (message.method === "session/update") {
          const commands = acpCommandsSchema.safeParse(message.params);
          if (commands.success) active.commands = { method: message.method, params: commands.data };
        }
        for (const listener of listeners) listener(message);
      }
    };
    connection = active;
    connections.set(key, connection);
  }
  const active = connection;
  active.users++;
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (method === "initialize")
      return (active.initialization ??= active.transport.request(method, params).then((result) => {
        if (input.harness === "opencode") {
          const capabilities = acpInitializationSchema.parse(result).agentCapabilities;
          active.deleteSession = capabilities.sessionCapabilities?.delete !== undefined;
          active.loadSession = capabilities.loadSession === true;
        }
        if (input.harness === "codex") active.transport.notify("initialized", {});
        return result;
      }));
    if (input.harness === "opencode" && method === "session/new")
      return (active.session ??= (async () => {
        if (!active.deleteSession && !active.loadSession)
          throw new Error(
            "Update OpenCode to discover models and commands without leaving empty sessions.",
          );
        let cached = active.loadSession ? discoverySessions.get(key) : undefined;
        let result: unknown;
        if (cached) {
          try {
            result = await active.transport.request("session/load", {
              ...object(params),
              sessionId: cached,
            });
          } catch (error) {
            if (!(error instanceof HarnessRequestError)) throw error;
          }
        }
        if (result === undefined) {
          cached = undefined;
          result = await active.transport.request(method, params);
        }
        const response = object(result);
        const sessionId = nativeSessionIdSchema.parse(response.sessionId ?? cached);
        active.sessionId = sessionId;
        if (!active.deleteSession) rememberSession(key, sessionId);
        return { ...response, sessionId };
      })());
    return active.transport.request(method, params);
  };
  try {
    if (onMessage) {
      active.listeners.add(onMessage);
      if (active.commands) onMessage(active.commands);
    }
    return await use(request);
  } finally {
    if (onMessage) active.listeners.delete(onMessage);
    if (--active.users === 0) {
      if (connections.get(key) === active) connections.delete(key);
      if (active.deleteSession && active.sessionId) {
        try {
          await active.transport.request("session/delete", { sessionId: active.sessionId }, 1000);
          if (discoverySessions.get(key) === active.sessionId) discoverySessions.delete(key);
        } catch {
          rememberSession(key, active.sessionId);
        }
      }
      clearTimeout(active.timer);
      active.transport.close();
      await active.transport.done;
    }
  }
}
