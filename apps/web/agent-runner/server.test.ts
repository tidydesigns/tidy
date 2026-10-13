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
