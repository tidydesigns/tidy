import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentOperationError, type AgentScope } from "./contracts";
import { TaskStoreError } from "./task-store";
import { CloudComputeBusyError } from "../cloud/cloud-compute";
import { DesignVersionConflictError } from "../workspace/project-store";
import type { AgentMcpConnection } from "../harnesses/session-types";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodObject;
  readOnly?: boolean;
  invoke(input: unknown): Promise<unknown>;
};
type Session = {
  scope: Omit<AgentScope, "signal">;
  controller: AbortController;
  authorize(): Promise<AbortSignal | void>;
  createdAt: number;
  usedAt: number;
  active: number;
};
const outputSchema = z.object({}).catchall(z.unknown());
const maxBodyBytes = 1024 * 1024;
const renderResultSchema = z
  .object({
    kind: z.literal("rendered"),
    mime_type: z.literal("image/png"),
    data: z
      .string()
      .max(2_796_204)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .passthrough();
const maxResultBytes = 256 * 1024;
const maxLifetimeMs = 8 * 60 * 60_000;
const idleLifetimeMs = 4 * 60 * 60_000;

async function untilAborted<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let aborted = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([action(), cancelled]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

export class AgentMcpBridge {
  private closing = false;
  private sessions = new Map<string, Session>();
  private pending?: Promise<string>;
  private active = 0;
  private server = createServer((request, response) => {
    void this.handle(request, response).catch(() => {
      if (response.writableEnded || response.destroyed) return;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  constructor(
    private options: {
      tools(scope: AgentScope): ToolDefinition[];
      toolTimeoutMs?: number;
      requestTimeoutMs?: number;
    },
  ) {
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.maxHeadersCount = 32;
    this.server.unref();
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    const address = this.server.address();
    const expectedHost = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    const authorization = request.headers.authorization;
    this.expire();
    const session = authorization?.startsWith("Bearer ")
      ? this.sessions.get(authorization.slice(7))
      : undefined;
    if (
      this.closing ||
      request.headers.origin !== undefined ||
      request.headers.host !== expectedHost ||
      !session ||
      request.url !== "/mcp"
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      response.writeHead(405).end();
      return;
    }
    if (this.active >= 32 || session.active >= 8) {
      response.setHeader("Retry-After", "1");
      response.writeHead(429).end();
      return;
    }
    this.active++;
    session.active++;
    const controller = new AbortController();
    const aborted = () => {
      if (!response.writableFinished) controller.abort(new Error("The tool request disconnected."));
    };
    const cancelRequest = () => request.destroy();
    let requestSignal: AbortSignal | undefined;
    response.once("close", aborted);
    try {
      const signal = AbortSignal.any([
        controller.signal,
        session.controller.signal,
        AbortSignal.timeout(Math.max(1, Math.min(30_000, this.options.requestTimeoutMs ?? 30_000))),
        AbortSignal.timeout(
          Math.max(1, Math.min(maxLifetimeMs - (Date.now() - session.createdAt), idleLifetimeMs)),
        ),
      ]);
      requestSignal = signal;
      signal.addEventListener("abort", cancelRequest, { once: true });
      signal.throwIfAborted();
      session.usedAt = Date.now();
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBodyBytes) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      signal.throwIfAborted();
      const body = Buffer.concat(chunks);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body.toString("utf8"));
      } catch {
        parsedBody = undefined;
      }
      if (Array.isArray(parsedBody)) {
        response.writeHead(400).end();
        return;
      }
      const discovery = z
        .object({
          method: z.enum([
            "initialize",
            "notifications/initialized",
            "tools/list",
            "server/discover",
          ]),
        })
        .safeParse(parsedBody).success;
      if (!discovery) {
        try {
          await untilAborted(signal, () => session.authorize());
        } catch {
          response.writeHead(403).end();
          return;
        }
      }
      const scope: AgentScope = {
        ...session.scope,
        designIds: [...session.scope.designIds],
        signal,
      };
      const handler = createMcpHandler(
        () => {
          const server = new McpServer({ name: "tidy", version: "1.0.0" });
          for (const tool of this.options.tools(scope)) {
            server.registerTool(
              tool.name,
              {
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema ?? outputSchema,
                annotations: {
                  readOnlyHint: tool.readOnly ?? false,
                  openWorldHint: false,
                },
              },
              async (input) => {
                let toolSignal = signal;
                try {
                  signal.throwIfAborted();
                  const turnSignal = await untilAborted(signal, () => session.authorize());
                  toolSignal = AbortSignal.any([
                    signal,
                    AbortSignal.timeout(
                      Math.max(1, Math.min(25_000, this.options.toolTimeoutMs ?? 25_000)),
                    ),
                    ...(turnSignal ? [turnSignal] : []),
                  ]);
                  toolSignal.throwIfAborted();
                  const scopedTool = this.options
                    .tools({ ...scope, designIds: [...scope.designIds], signal: toolSignal })
                    .find((candidate) => candidate.name === tool.name);
                  if (!scopedTool)
                    throw new AgentOperationError("UNAVAILABLE", "This tool is unavailable.");
                  const output = outputSchema.parse(
                    await untilAborted(toolSignal, () => scopedTool.invoke(input)),
                  );
                  toolSignal.throwIfAborted();
                  await untilAborted(signal, () => session.authorize());
                  const imageResult =
                    output.kind === "rendered" ? renderResultSchema.parse(output) : undefined;
                  const { data: imageData, ...imageMetadata } = imageResult ?? { data: undefined };
                  if (imageData && Buffer.byteLength(imageData, "base64") > 2 * 1024 * 1024)
                    throw new AgentOperationError("BUSY", "The rendered image exceeds 2 MB.");
                  const metadata = scopedTool.outputSchema
                    ? scopedTool.outputSchema.parse(imageResult ? imageMetadata : output)
                    : imageResult
                      ? imageMetadata
                      : output;
                  const text = JSON.stringify(metadata);
                  if (Buffer.byteLength(text) > maxResultBytes)
                    throw new AgentOperationError(
                      "BUSY",
                      "The tool result exceeds its limit. Request a smaller scope.",
                    );
                  return {
                    content: [
                      { type: "text", text },
                      ...(imageData
                        ? [{ type: "image" as const, mimeType: "image/png", data: imageData }]
                        : []),
                    ],
                    structuredContent: metadata,
                  };
                } catch (error) {
                  const failure = toolSignal.aborted
                    ? { code: "UNAVAILABLE", message: "Tool access expired." }
                    : error instanceof CloudComputeBusyError
                      ? { code: "BUSY", message: "The design worker is busy. Retry shortly." }
                      : error instanceof DesignVersionConflictError
                        ? {
                            code: "CONFLICT",
                            message:
                              "This design changed. Read its latest version and use a new transaction request ID.",
                          }
                        : error instanceof AgentOperationError
                          ? { code: error.code, message: error.message.slice(0, 2000) }
                          : error instanceof TaskStoreError
                            ? {
                                code: [
                                  "REQUEST_CONFLICT",
                                  "INVALID_STATE",
                                  "RECEIPT_EXPIRED",
                                ].includes(error.code)
                                  ? "CONFLICT"
                                  : error.code === "CAPACITY"
                                    ? "CAPACITY"
                                    : ["CONFLICT", "BUSY", "NOT_FOUND", "INVALID_CURSOR"].includes(
                                          error.code,
                                        )
                                      ? error.code
                                      : "UNAVAILABLE",
                                message:
                                  error.code === "REQUEST_CONFLICT"
                                    ? "This request ID belongs to different input. Repeat the original input or use a new request ID."
                                    : error.code === "INVALID_STATE"
                                      ? "This assignment state changed. Read its current result before continuing."
                                      : error.code === "RECEIPT_EXPIRED"
                                        ? "This edit receipt expired after the retention window. Inspect the current design and use a new request ID; it cannot be replayed or undone automatically."
                                        : error.code === "CAPACITY"
                                          ? "Local retained history reached its safety limit. Older settled results are compacted after 30 days; preserve this project and contact support before resetting storage."
                                          : "Assignment storage could not complete this operation.",
                              }
                            : error instanceof z.ZodError
                              ? {
                                  code: "INVALID_INPUT",
                                  message: "The tool input or output did not match its schema.",
                                }
                              : {
                                  code: "INTERNAL",
                                  message:
                                    "The tool could not complete. Retry with the same request identifier.",
                                };
                  const output = {
                    error: {
                      ...failure,
                      retryable: ["BUSY", "UNAVAILABLE"].includes(failure.code),
                    },
                  };
                  return {
                    isError: true,
                    content: [{ type: "text", text: JSON.stringify(output) }],
                    structuredContent: output,
                  };
                }
              },
            );
          }
          return server;
        },
        { maxRequestBodySize: maxBodyBytes },
      );
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const result = await handler.fetch(
        new Request(`http://${expectedHost}/mcp`, {
          method: "POST",
          headers,
          body,
          signal,
        }),
        { parsedBody },
      );
      signal.throwIfAborted();
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        const reader = result.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            signal.throwIfAborted();
            if (!response.write(value))
              await new Promise<void>((resolve, reject) => {
                const drained = () => {
                  response.removeListener("close", closed);
                  resolve();
                };
                const closed = () => {
                  response.removeListener("drain", drained);
                  reject(new Error("The tool request disconnected."));
                };
                response.once("drain", drained);
                response.once("close", closed);
              });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      response.end();
    } finally {
      response.removeListener("close", aborted);
      requestSignal?.removeEventListener("abort", cancelRequest);
      this.active--;
      session.active--;
    }
  }

  private start() {
    this.pending ??= new Promise<string>((resolve, reject) => {
      const failed = (error: Error) => {
        this.server.removeListener("listening", listening);
        reject(error);
      };
      const listening = () => {
        this.server.removeListener("error", failed);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Application tools could not start."));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/mcp`);
      };
      this.server.once("error", failed);
      this.server.once("listening", listening);
      this.server.listen(0, "127.0.0.1");
    }).catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private expire() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.createdAt < maxLifetimeMs && now - session.usedAt < idleLifetimeMs)
        continue;
      this.sessions.delete(token);
      session.controller.abort(new Error("Application tool access expired."));
    }
  }

  async session({
    authorize,
    ...scope
  }: Omit<AgentScope, "signal"> & {
    authorize(): Promise<AbortSignal | void>;
  }): Promise<AgentMcpConnection> {
    if (this.closing) throw new Error("Application tools are closing.");
    this.expire();
    if (this.sessions.size >= 128) throw new Error("Application tool session limit reached.");
    const url = await this.start();
    if (this.closing) throw new Error("Application tools are closing.");
    const token = randomBytes(32).toString("hex");
    const controller = new AbortController();
    if (this.sessions.size >= 128) throw new Error("Application tool session limit reached.");
    this.sessions.set(token, {
      scope: { ...scope, designIds: [...scope.designIds] },
      authorize,
      controller,
      createdAt: Date.now(),
      usedAt: Date.now(),
      active: 0,
    });
    const available = () => {
      this.expire();
      return this.sessions.has(token);
    };
    return {
      url,
      token,
      toolNames: Object.freeze(
        this.options.tools({ ...scope, signal: controller.signal }).map((tool) => tool.name),
      ),
      get available() {
        return available();
      },
      close: () => {
        if (!this.sessions.delete(token)) return;
        controller.abort(new Error("Application tool access expired."));
      },
    };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const session of this.sessions.values())
      session.controller.abort(new Error("Application tools are closing."));
    this.sessions.clear();
    await this.pending?.catch(() => {});
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
