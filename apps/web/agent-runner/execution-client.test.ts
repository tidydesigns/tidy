import { afterEach, expect, test } from "bun:test";
import { executionClient } from "./executor";
import { executionRunSchema, executionWorkerSchema } from "../lib/agents/execution-protocol";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("malformed successful writes are validated outside transport retries", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return Response.json({ id: 42 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const request = executionClient("http://localhost", "fixture");
  await expect(
    request({
      action: "spawn",
      runId: "run",
      generation: 1,
      agentId: "agent",
      callId: "call",
      name: "Worker",
      task: "Task",
    }).then((value) => executionWorkerSchema.parse(value)),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

test("an unreadable claim response is never retried", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return new Response("invalid");
    },
    { preconnect: originalFetch.preconnect },
  );
  await expect(
    executionClient("http://localhost", "fixture")({ action: "claim", runnerId: "runner" }),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

test("execution scope can grow beyond the initial file admission limit", () => {
  const worker = { id: "lead", parentId: null, name: "Lead", task: "Task", runtimeThreadId: null };
  const run = {
    id: "run",
    threadId: "thread",
    organizationId: "org",
    owner: "owner",
    generation: 1,
    model: "model",
    agentLimit: 1,
    allowOrganizationChanges: true,
    files: Array.from({ length: 11 }, (_, index) => ({ id: `file-${index}`, selectedNodeIds: [] })),
    workers: [worker],
    messages: [],
    tools: [],
  };
  expect(executionRunSchema.safeParse(run).success).toBe(true);
  expect(executionRunSchema.safeParse({ ...run, workers: [] }).success).toBe(false);
});
