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
