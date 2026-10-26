import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRunnerHandler } from "./server";

test("runner authenticates before creating runtimes and isolates each account", async () => {
  const methods: string[] = [],
    paths: string[] = [],
    secret = "local-test-runner-secret-that-is-long-enough";
  class FakeRuntime extends EventEmitter {
    async start() {}
    async request<T>(method: string): Promise<T> {
      methods.push(method);
      return { account: { type: "chatgpt" } } as T;
    }
    reject() {}
    respond() {}
    close() {}
  }
  const handler = createRunnerHandler({
    secret,
    directory: "/tmp/isolated-runtimes",
    createRuntime: (path) => {
      paths.push(path);
      return new FakeRuntime();
    },
  });
  const request = (owner: string, auth = secret, action = "account") =>
    new Request(`http://localhost/v1/accounts/${owner}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });
  expect((await handler.fetch(request("a".repeat(64), "incorrect"))).status).toBe(401);
  expect(paths).toHaveLength(0);
  expect((await handler.fetch(request("../escape"))).status).toBe(404);
  await handler.fetch(request("a".repeat(64)));
  await handler.fetch(request("b".repeat(64)));
  await handler.fetch(request("a".repeat(64)));
  expect(paths).toHaveLength(2);
  expect(paths[0]).not.toBe(paths[1]);
  expect(methods).toEqual(["account/read", "account/read", "account/read"]);
  expect((await handler.fetch(request("a".repeat(64), secret, "shell"))).status).toBe(404);
  handler.close();
});

test("erasure removes the private runner directory and is idempotent without starting a runtime", async () => {
  const { mkdtemp, writeFile, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "tidy-privacy-runner-"));
  const owner = "e".repeat(64),
    secret = "local-test-runner-secret-that-is-long-enough";
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(directory, owner));
  await writeFile(join(directory, owner, "auth.json"), "private-fixture");
  let started = false;
  const handler = createRunnerHandler({
    secret,
    directory,
    createRuntime: () => {
      started = true;
      throw new Error("Must not start");
    },
  });
  try {
    for (let i = 0; i < 2; i++)
      expect(
        (
          await handler.fetch(
            new Request(`http://localhost/v1/accounts/${owner}/erase`, {
              method: "POST",
              headers: { authorization: `Bearer ${secret}` },
            }),
          )
        ).status,
      ).toBe(200);
    await expect(access(join(directory, owner))).rejects.toThrow();
    expect(started).toBe(false);
  } finally {
    handler.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("erasure waits for runtime exit and fences concurrent recreation", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "tidy-privacy-stop-"));
  const owner = "d".repeat(64),
    secret = "local-test-runner-secret-that-is-long-enough";
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class Runtime extends EventEmitter {
    async start() {}
    async request<T>(): Promise<T> {
      return {} as T;
    }
    reject() {}
    respond() {}
    close() {}
    async stop() {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  }
  const handler = createRunnerHandler({ secret, directory, createRuntime: () => new Runtime() });
  const request = (action: string) =>
    new Request(`http://localhost/v1/accounts/${owner}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
  try {
    expect((await handler.fetch(request("account"))).status).toBe(200);
    let finished = false;
    const erasure = handler.fetch(request("erase")).then((response) => {
      finished = true;
      return response;
    });
    await waiting;
    expect(finished).toBe(false);
    expect((await handler.fetch(request("login"))).status).toBe(502);
    release();
    expect((await erasure).status).toBe(200);
    expect((await handler.fetch(request("account"))).status).toBe(502);
  } finally {
    release?.();
    handler.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function poolFixture(capacity = 2) {
  let time = 0;
  const runtimes: FixtureRuntime[] = [];
  class FixtureRuntime extends EventEmitter {
    stopped = false;
    methods: string[] = [];
    startup: Promise<void> = Promise.resolve();
    stopping: Promise<void> = Promise.resolve();
    async start() {
      await this.startup;
    }
    async request<T>(method: string): Promise<T> {
      this.methods.push(method);
      return { loginId: "fixture" } as T;
    }
    reject() {}
    respond() {}
    close() {
      this.stopped = true;
    }
    async stop() {
      await this.stopping;
      this.close();
    }
  }
  const secret = "local-test-runner-secret-that-is-long-enough";
  const handler = createRunnerHandler({
    secret,
    directory: "/tmp/runner-pool-fixture",
    capacity,
    idleMs: 100,
    now: () => time,
    createRuntime: () => {
      const app = new FixtureRuntime();
      runtimes.push(app);
      return app;
    },
  });
  return {
    handler,
    runtimes,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    request: (owner: string, action: string) =>
      handler.fetch(
        new Request(`http://localhost/v1/accounts/${owner.repeat(64)}/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
        }),
      ),
  };
}

test("pool protects active leases and reuses warm accounts", async () => {
  const { handler, runtimes, advance } = poolFixture(1);
  try {
    const first = await handler.acquire("a");
    const second = await handler.acquire("a");
    expect(second.runtime).toBe(first.runtime);
    expect(runtimes).toHaveLength(1);
    first.release();
    first.release();
    advance(1000);
    await handler.sweep();
    expect(runtimes[0].stopped).toBe(false);
    await expect(handler.acquire("b")).rejects.toThrow("capacity");
    second.release();
    advance(99);
    await handler.sweep();
    expect(runtimes[0].stopped).toBe(false);
    advance(1);
    await handler.sweep();
    expect(runtimes[0].stopped).toBe(true);
    const restarted = await handler.acquire("a");
    expect(restarted.runtime).not.toBe(first.runtime);
    restarted.release();
  } finally {
    handler.close();
  }
});

test("pool preserves pending sign-in until expiry and then recovers capacity", async () => {
  const { handler, runtimes, request, advance } = poolFixture(1);
  try {
    expect((await request("a", "login")).status).toBe(200);
    advance(8 * 60_000);
    await handler.sweep();
    expect(runtimes[0].stopped).toBe(false);
    const busy = await request("b", "login");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("5");
    expect(runtimes).toHaveLength(1);
    advance(60_000);
    await handler.sweep();
    expect(runtimes[0].stopped).toBe(true);
    expect((await request("b", "login")).status).toBe(200);
    runtimes[1].emit("notification", { method: "account/login/completed" });
    advance(100);
    await handler.sweep();
    expect(runtimes[1].stopped).toBe(true);
  } finally {
    handler.close();
  }
});

test("retiring processes keep their capacity slot until shutdown completes", async () => {
  const { handler, runtimes } = poolFixture(1);
  let exit!: () => void;
  try {
    const first = await handler.acquire("a");
    runtimes[0].stopping = new Promise<void>((resolve) => {
      exit = resolve;
    });
    first.release();
    const next = handler.acquire("b");
    await Promise.resolve();
    await expect(handler.acquire("c")).rejects.toThrow("capacity");
    expect(runtimes).toHaveLength(1);
    exit();
    const second = await next;
    expect(runtimes[0].stopped).toBe(true);
    expect(runtimes).toHaveLength(2);
    second.release();
  } finally {
    exit?.();
    handler.close();
  }
});

test("startup reservations count against capacity and failed starts are reclaimed", async () => {
  const { handler, runtimes } = poolFixture(1);
  let fail!: (error: Error) => void;
  try {
    const initial = await handler.acquire("a");
    initial.release();
    runtimes[0].startup = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const pending = handler.acquire("a");
    const rejection = pending.catch((error: Error) => error);
    await expect(handler.acquire("b")).rejects.toThrow("capacity");
    fail(new Error("fixture start failure"));
    expect(await rejection).toMatchObject({ message: "fixture start failure" });
    expect(runtimes[0].stopped).toBe(true);
    const recovered = await handler.acquire("b");
    recovered.release();
  } finally {
    handler.close();
  }
});

test.each(["stop rejection", "close exception"])(
  "failed retirement recovers the account, login state and capacity after %s",
  async (failure) => {
    const { handler, runtimes, request, advance } = poolFixture(1);
    try {
      expect((await request("a", "login")).status).toBe(200);
      const failedRuntime = runtimes[0];
      if (failure === "stop rejection") {
        failedRuntime.stop = async () => {
          throw new Error("fixture shutdown failure");
        };
      } else {
        Object.defineProperty(failedRuntime, "stop", { value: undefined });
        failedRuntime.close = () => {
          throw new Error("fixture close failure");
        };
      }
      advance(9 * 60_000);
      await expect(handler.sweep()).rejects.toThrow("fixture");
      expect((await request("a", "login")).status).toBe(200);
      expect(runtimes).toHaveLength(2);
      expect(runtimes[1].methods).toEqual(["account/logout", "account/login/start"]);
      // A stale pending login would prevent this completed account from retiring.
      runtimes[1].emit("notification", { method: "account/login/completed" });
      advance(100);
      await handler.sweep();
      expect(runtimes[1].stopped).toBe(true);
      expect((await request("b", "account")).status).toBe(200);
    } finally {
      handler.close();
    }
  },
);
