import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { browserActionSchema, type BrowserScope } from "../../shared/contracts/browser";
import type { BrowserService } from "./browser-service";

const requestSchema = z.union([
  browserActionSchema,
  z.object({ kind: z.literal("state") }).strict(),
]);

export class BrowserAgentBridge {
  private closing = false;
  private sessions = new Map<
    string,
    { scope: BrowserScope; controller: AbortController; directory: string }
  >();
  private pending?: Promise<{ origin: string }>;
  private cleanups = new Set<Promise<void>>();
  private server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      const session = token ? this.sessions.get(token) : undefined;
      if (
        request.headers.origin ||
        !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "") ||
        !session ||
        request.method !== "POST" ||
        request.url !== "/browser"
      ) {
        response.writeHead(403);
        response.end(JSON.stringify({ error: "Browser access denied." }));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 128 * 1024) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(chunk);
      }
      session.controller.signal.throwIfAborted();
      const action = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result =
        action.kind === "state"
          ? { state: await this.browser.state(session.scope) }
          : await this.browser.command(session.scope, action, {
              signal: session.controller.signal,
            });
      session.controller.signal.throwIfAborted();
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      if (response.writableEnded) return;
      response.writeHead(400);
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Browser action failed.",
        }),
      );
    });
  });

  constructor(private readonly browser: BrowserService) {
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 10000;
    this.server.unref();
  }

  private start() {
    this.pending ??= (async () => {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          this.server.removeListener("listening", listening);
          reject(error);
        };
        const listening = () => {
          this.server.removeListener("error", failed);
          resolve();
        };
        this.server.once("error", failed);
        this.server.once("listening", listening);
        this.server.listen(0, "127.0.0.1");
      });
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Browser tool could not start.");
      return { origin: `http://127.0.0.1:${address.port}/browser` };
    })().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  async session(scope: BrowserScope) {
    if (this.closing) throw new Error("The browser tool is closing.");
    const host = await this.start();
    if (this.closing) throw new Error("The browser tool is closing.");
    const token = randomBytes(32).toString("hex");
    const controller = new AbortController();
    const directory = await mkdtemp(join(tmpdir(), "tidy-browser-agent-"));
    const configuration = join(directory, "client.conf");
    try {
      await writeFile(
        configuration,
        `url = "${host.origin}"\nheader = "Authorization: Bearer ${token}"\nheader = "Content-Type: application/json"\n`,
        { mode: 0o600 },
      );
      if (this.closing) throw new Error("The browser tool is closing.");
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.sessions.set(token, { scope, controller, directory });
    const quotedConfiguration =
      process.platform === "win32"
        ? `'${configuration.replaceAll("'", "''")}'`
        : `'${configuration.replaceAll("'", "'\\''")}'`;
    const command = `${process.platform === "win32" ? "curl.exe" : "curl"} --config ${quotedConfiguration} --silent --show-error --fail-with-body --max-time 180 --data`;
    return {
      configuration,
      instructions: `\n\nA shared browser is available on this project host. Use ${command} '<JSON action>' to drive the same tabs the user sees. This private configuration is valid only for this turn; use this path instead of any earlier browser configuration. Do not print its contents. Start with {"kind":"state"}; open with {"kind":"open","url":"http://localhost:3000"}. Actions accept tabId: snapshot (accessibility tree), screenshot (base64 JPEG), console, navigate (url), click (selector), fill (selector,text), evaluate (expression), back, forward, reload, stop, close. Prefer accessible selectors such as ::-p-aria(Continue) from a fresh snapshot; use specific selectors, inspect console errors, and verify your work in this browser. Do not start a separate browser. Use click and fill for interactions instead of scheduling delayed interactions in evaluate; JavaScript already submitted to a page cannot be undone when control changes. If a viewer has control, stop browser actions until they release it. Only interact with pages needed for the user's task. Ask before consequential external actions or submitting credentials. localhost refers to this host. Browser tools are scoped to this thread.`,
      close: () => {
        if (!this.sessions.delete(token)) return;
        controller.abort(new Error("Browser access expired."));
        this.browser.cancelAgent(scope);
        const cleanup = rm(directory, { recursive: true, force: true });
        this.cleanups.add(cleanup);
        void cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
      },
    };
  }

  async close() {
    this.closing = true;
    const directories = [...this.sessions.values()].map((session) => session.directory);
    for (const session of this.sessions.values())
      session.controller.abort(new Error("The browser tool is closing."));
    this.sessions.clear();
    await this.pending?.catch(() => undefined);
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled([
      ...this.cleanups,
      ...directories.map((directory) => rm(directory, { recursive: true, force: true })),
    ]);
  }
}
