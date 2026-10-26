import { z } from "zod";
import { rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { CodexAppServer } from "./app-server";

export type Runtime = Pick<CodexAppServer, "start" | "request" | "reject" | "respond" | "close"> &
  Pick<EventEmitter, "on" | "off"> &
  Partial<Pick<CodexAppServer, "stop">>;
export type RuntimeLease = { runtime: Runtime; release: () => void };
type Entry = { app: Runtime; users: number; lastUsed: number; closing?: Promise<void> };
class RuntimeCapacityError extends Error {}
type RunnerOptions = {
  secret: string;
  directory: string;
  capacity?: number;
  idleMs?: number;
  now?: () => number;
  createRuntime?: (directory: string) => Runtime;
  onRuntime?: (owner: string, runtime: Runtime) => void;
};
const actions = new Set(["login", "account", "logout", "erase", "limits", "models"]);

export function createRunnerHandler(options: RunnerOptions) {
  if (options.secret.length < 32)
    throw new Error("AGENT_RUNNER_SECRET must contain at least 32 characters.");
  const accounts = new Map<string, Entry>();
  const capacity = options.capacity ?? 64;
  const idleMs = options.idleMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(idleMs) || idleMs < 1)
    throw new Error("Invalid runtime capacity or idle timeout.");
  let closed = false;
  const erased = new Set<string>();
  const logins = new Map<string, { result: Promise<{ loginId?: string }>; expiresAt: number }>();
  const makeRuntime = options.createRuntime ?? ((directory) => new CodexAppServer(directory));
  const secret = Buffer.from(`Bearer ${options.secret}`);
  function retire(owner: string, entry: Entry) {
    if (!entry.closing) {
      // Retiring processes retain their capacity slot until shutdown settles.
      entry.closing = Promise.resolve().then(async () => {
        try {
          if (entry.app.stop) await entry.app.stop();
          else entry.app.close();
        } finally {
          if (accounts.get(owner) === entry) {
            accounts.delete(owner);
            logins.delete(owner);
          }
        }
      });
    }
    return entry.closing;
  }
  async function sweep() {
    await Promise.all(
      [...accounts].map(async ([owner, entry]) => {
        if (entry.users || entry.closing) return;
        const login = logins.get(owner);
        if (login ? login.expiresAt <= now() : now() - entry.lastUsed >= idleMs)
          await retire(owner, entry);
      }),
    );
  }
  const cleanup = setInterval(() => void sweep().catch(() => {}), 30_000);
  cleanup.unref();
  async function acquire(owner: string): Promise<RuntimeLease> {
    if (closed || erased.has(owner)) throw new Error("Account runtime is unavailable.");
    let entry = accounts.get(owner);
    if (entry?.closing) {
      // The retiring caller owns shutdown errors; this request only needs its slot.
      await entry.closing.catch(() => {});
      return acquire(owner);
    }
    if (!entry) {
      if (accounts.size >= capacity) {
        const candidate = [...accounts]
          .filter(
            ([id, value]) =>
              !value.users &&
              !value.closing &&
              (!logins.has(id) || logins.get(id)!.expiresAt <= now()),
          )
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!candidate) throw new RuntimeCapacityError("Runtime capacity is busy.");
        await retire(...candidate).catch(() => {});
        return acquire(owner);
      }
      const app = makeRuntime(resolve(options.directory, owner));
      entry = { app, users: 0, lastUsed: now() };
      accounts.set(owner, entry);
      if (options.onRuntime) options.onRuntime(owner, app);
      else app.on("request", (message: { id: string | number }) => app.reject(message.id));
      app.on("notification", (message: { method: string }) => {
        if (message.method === "account/login/completed" && accounts.get(owner) === entry)
          logins.delete(owner);
      });
    }
    const current = entry;
    current.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.users--;
      current.lastUsed = now();
    };
    try {
      await current.app.start();
      if (closed || erased.has(owner) || current.closing)
        throw new Error("Account runtime is unavailable.");
      return { runtime: current.app, release };
    } catch (error) {
      release();
      await retire(owner, current);
      throw error;
    }
  }
  return {
    acquire,
    sweep,
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
      let lease: RuntimeLease | undefined;
      try {
        if (action === "erase") {
          erased.add(owner);
          const entry = accounts.get(owner);
          if (entry) await retire(owner, entry);
          await rm(resolve(options.directory, owner), { recursive: true, force: true });
          return Response.json({ ok: true });
        }
        lease = await acquire(owner);
        const app = lease.runtime;
        if (action === "login") {
          let login = logins.get(owner);
          if (login && login.expiresAt < now()) {
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
                .request("account/login/start", { type: "chatgptDeviceCode" })
                .then((value) => z.looseObject({ loginId: z.string().optional() }).parse(value))
                .catch((error) => {
                  logins.delete(owner);
                  throw error;
                }),
              expiresAt: now() + 9 * 60_000,
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
          const entry = accounts.get(owner);
          if (entry) await retire(owner, entry);
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
      } catch (error) {
        if (error instanceof RuntimeCapacityError)
          return Response.json(
            { error: "Codex is busy. Try again shortly." },
            { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } },
          );
        return Response.json({ error: "Codex runtime request failed." }, { status: 502 });
      } finally {
        lease?.release();
      }
    },
    close() {
      closed = true;
      clearInterval(cleanup);
      for (const { app } of accounts.values()) app.close();
      accounts.clear();
      logins.clear();
    },
  };
}
