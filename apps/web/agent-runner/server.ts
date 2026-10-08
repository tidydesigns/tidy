import { timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { CodexAppServer } from "./app-server";

export type Runtime = Pick<CodexAppServer, "start" | "request" | "reject" | "respond" | "close"> &
  Pick<EventEmitter, "on" | "off">;
type RunnerOptions = {
  secret: string;
  directory: string;
  createRuntime?: (directory: string) => Runtime;
  onRuntime?: (owner: string, runtime: Runtime) => void;
};
const actions = new Set(["login", "account", "logout", "limits", "models"]);

export function createRunnerHandler(options: RunnerOptions) {
  if (options.secret.length < 32)
    throw new Error("AGENT_RUNNER_SECRET must contain at least 32 characters.");
  const accounts = new Map<string, Runtime>();
  const logins = new Map<string, { result: Promise<{ loginId?: string }>; expiresAt: number }>();
  const makeRuntime = options.createRuntime ?? ((directory) => new CodexAppServer(directory));
  const secret = Buffer.from(`Bearer ${options.secret}`);
  async function runtime(owner: string) {
    let app = accounts.get(owner);
    if (!app) {
      app = makeRuntime(resolve(options.directory, owner));
      // Until an execution session installs its typed tool handlers, deny every
      // server-initiated operation. Login cannot enable arbitrary local tools.
      if (options.onRuntime) options.onRuntime(owner, app);
      else app.on("request", (message: { id: string | number }) => app!.reject(message.id));
      app.on("notification", (message: { method: string }) => {
        if (message.method === "account/login/completed") logins.delete(owner);
      });
      accounts.set(owner, app);
    }
    await app.start();
    return app;
  }
  return {
    runtime,
    async fetch(request: Request) {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
        return new Response(null, { status: 401 });
      const match = new URL(request.url).pathname.match(
        /^\/v1\/accounts\/([a-f0-9]{64})\/([a-z]+)$/,
      );
      if (request.method !== "POST" || !match || !actions.has(match[2]))
        return new Response(null, { status: 404 });
      const [, owner, action] = match;
      try {
        const app = await runtime(owner);
        if (action === "login") {
          let login = logins.get(owner);
          if (login && login.expiresAt < Date.now()) {
            const old = await login.result.catch(() => null);
            if (old?.loginId) await app.request("account/login/cancel", { loginId: old.loginId });
            logins.delete(owner);
            login = undefined;
          }
          if (!login) {
            // A previous account must not satisfy the polling check for a new
            // device-code attempt before the user has completed that attempt.
            await app.request("account/logout");
            login = {
              result: app
                .request<{ loginId?: string }>("account/login/start", { type: "chatgptDeviceCode" })
                .catch((error) => {
                  logins.delete(owner);
                  throw error;
                }),
              expiresAt: Date.now() + 9 * 60_000,
            };
            logins.set(owner, login);
          }
          return Response.json(await login.result, { headers: { "Cache-Control": "no-store" } });
        }
        if (action === "logout") {
          const login = await logins.get(owner)?.result.catch(() => null);
          if (login?.loginId)
            await app.request("account/login/cancel", { loginId: login.loginId }).catch(() => {});
          logins.delete(owner);
          await app.request("account/logout");
          app.close();
          accounts.delete(owner);
          return Response.json({ ok: true });
        }
        const method =
          action === "account"
            ? "account/read"
            : action === "limits"
              ? "account/rateLimits/read"
              : "model/list";
        const result = await app.request(
          method,
          action === "account" ? { refreshToken: false } : {},
        );
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ error: "Codex runtime request failed." }, { status: 502 });
      }
    },
    close() {
      for (const runtime of accounts.values()) runtime.close();
      accounts.clear();
      logins.clear();
    },
  };
}
