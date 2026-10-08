import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AgentExecutor, ExecutionError, toolResponse } from "./executor";
import type {
  ExecutionRequest,
  ExecutionRun,
  ExecutionWorker,
} from "../lib/agents/execution-protocol";
import type { RpcMessage } from "./app-server";

function fixture(owner: string, count: number): ExecutionRun {
  return {
    id: randomUUID(),
    threadId: randomUUID(),
    organizationId: "organisation",
    owner,
    generation: 1,
    model: "test-model",
    agentLimit: count,
    allowOrganizationChanges: false,
    files: [{ id: `file-${owner}`, selectedNodeIds: [] }],
    messages: [{ authorName: owner, kind: "user", content: "Improve the design" }],
    tools: [],
    workers: [
      {
        id: randomUUID(),
        parentId: null,
        name: "Lead",
        task: `Work for ${owner}`,
        runtimeThreadId: null,
      },
    ],
  };
}

test("managed runtime executes six agents and concurrent teammate threads without routing crossover", async () => {
  const runs = [fixture("alice", 6), fixture("bob", 3), fixture("bob", 2)],
    queue = [...runs];
  const completed = new Set<string>(),
    bindings = new Map<string, string>(),
    owners = new Map<string, string>();
  const messages: ExecutionRequest[] = [],
    workers = new Map<string, ExecutionWorker[]>();
  for (const run of runs) workers.set(run.id, [...run.workers]);
  const runtimes = new Map<string, FakeRuntime>();
  const remote = async <T>(input: ExecutionRequest): Promise<T> => {
    if (input.action === "claim") return { run: queue.shift() ?? null } as T;
    const run = runs.find((run) => run.id === input.runId)!;
    expect(input.generation).toBe(run.generation);
    if (input.action === "spawn") {
      const child = {
        id: randomUUID(),
        parentId: input.agentId,
        name: input.name,
        task: input.task,
        runtimeThreadId: null,
      };
      workers.get(run.id)!.push(child);
      return child as T;
    }
    if (input.action === "bind") {
      bindings.set(input.agentId, input.runtimeThreadId);
      owners.set(input.runtimeThreadId, run.owner);
    }
    if (input.action === "instructions") return { messages: [] } as T;
    if (input.action === "message") {
      expect(workers.get(run.id)!.some((worker) => worker.id === input.agentId)).toBe(true);
      expect(input.content).toContain(run.owner);
      messages.push(input);
    }
    if (input.action === "finish") {
      expect(input.status).toBe("completed");
      completed.add(run.id);
      return { pending: false } as T;
    }
    return {} as T;
  };
  class FakeRuntime extends EventEmitter {
    configs = new Map<string, Record<string, unknown>>();
    turns = new Map<string, number>();
    pending = new Map<number, (result: unknown) => void>();
    next = 1;
    constructor(readonly owner: string) {
      super();
    }
    async start() {}
    close() {}
    reject(id: string | number) {
      this.respond(id, { success: false });
    }
    respond(id: string | number, result: unknown) {
      this.pending.get(Number(id))?.(result);
      this.pending.delete(Number(id));
    }
    call(threadId: string, tool: string, args: Record<string, unknown>) {
      const id = this.next++;
      return new Promise((resolve) => {
        this.pending.set(id, resolve);
        this.emit("request", {
          id,
          method: "item/tool/call",
          params: {
            threadId,
            turnId: "turn",
            callId: String(id),
            namespace: null,
            tool,
            arguments: args,
          },
        } satisfies RpcMessage);
      });
    }
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === "account/read") return { account: { type: "chatgpt" } } as T;
      if (method === "thread/start") {
        expect(params.environments).toEqual([]);
        expect(params.approvalPolicy).toBe("never");
        const id = randomUUID();
        this.configs.set(id, params);
        return { thread: { id } } as T;
      }
      if (method === "turn/start") {
        const threadId = String(params.threadId),
          id = randomUUID();
        queueMicrotask(() => {
          void (async () => {
            this.emit("notification", {
              method: "turn/started",
              params: { threadId, turn: { id } },
            });
            const config = this.configs.get(threadId)!,
              count = this.turns.get(threadId) ?? 0;
            this.turns.set(threadId, count + 1);
            if (
              !count &&
              (config.dynamicTools as { name: string }[]).some(
                (tool) => tool.name === "tidy_spawn_agent",
              )
            ) {
              const maximum = Number(
                String(config.developerInstructions).match(/maximum of (\d+)/)?.[1],
              );
              for (let i = 1; i < maximum; i++)
                await this.call(threadId, "tidy_spawn_agent", {
                  name: `Worker ${i}`,
                  task: `Work for ${this.owner}`,
                });
              await this.call(threadId, "tidy_wait_agents", {});
            }
            const itemId = randomUUID();
            this.emit("notification", {
              method: "item/agentMessage/delta",
              params: { threadId, turnId: id, itemId, delta: `Completed work for ${this.owner}` },
            });
            this.emit("notification", {
              method: "item/completed",
              params: {
                threadId,
                turnId: id,
                item: { type: "reasoning", id: randomUUID(), text: "SECRET REASONING" },
              },
            });
            this.emit("notification", {
              method: "turn/completed",
              params: { threadId, turn: { id, status: "completed" } },
            });
          })();
        });
        return { turn: { id } } as T;
      }
      return {} as T;
    }
  }
  const executor = new AgentExecutor(remote, async (owner) => {
    let runtime = runtimes.get(owner);
    if (!runtime) {
      runtime = new FakeRuntime(owner);
      runtimes.set(owner, runtime);
      executor.attach(owner, runtime);
    }
    return runtime;
  });
  const running = executor.start();
  try {
    const until = Date.now() + 3000;
    while (completed.size < 3 && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed.size).toBe(3);
    expect(runtimes.size).toBe(2);
    expect(workers.get(runs[0].id)).toHaveLength(6);
    expect(workers.get(runs[1].id)).toHaveLength(3);
    expect(workers.get(runs[2].id)).toHaveLength(2);
    expect(bindings.size).toBe(11);
    expect(owners.size).toBe(11);
    expect(JSON.stringify(messages)).not.toContain("SECRET REASONING");
  } finally {
    executor.close();
    await running;
  }
});

test("dynamic tool output preserves image inputs and tool failures", () => {
  expect(
    toolResponse({ content: [{ type: "image", data: "YWJj", mimeType: "image/png" }] }),
  ).toEqual({
    success: true,
    contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,YWJj" }],
  });
  expect(
    toolResponse({ isError: true, content: [{ type: "text", text: "conflict" }] }).success,
  ).toBe(false);
});

test("history exhaustion stops the runtime instead of asking the model to retry tools", async () => {
  const run = fixture("alice", 1);
  let claimed = false,
    calls = 0,
    finish!: (request: ExecutionRequest) => void;
  const finished = new Promise<ExecutionRequest>((resolve) => {
    finish = resolve;
  });
  class Runtime extends EventEmitter {
    async start() {}
    close() {}
    respond() {}
    reject() {}
    async request<T>(method: string): Promise<T> {
      if (method === "account/read") return { account: { type: "chatgpt" } } as T;
      if (method === "thread/start") return { thread: { id: "runtime-thread" } } as T;
      if (method === "turn/start") {
        queueMicrotask(() =>
          this.emit("request", {
            id: 1,
            method: "item/tool/call",
            params: {
              threadId: "runtime-thread",
              turnId: "turn",
              callId: "tool",
              namespace: null,
              tool: "rename_file",
              arguments: { file_id: "file-alice", name: "New" },
            },
          }),
        );
        return { turn: { id: "turn" } } as T;
      }
      return {} as T;
    }
  }
  const runtime = new Runtime();
  const executor = new AgentExecutor(
    async <T>(request: ExecutionRequest): Promise<T> => {
      if (request.action === "claim") {
        const next = claimed ? null : run;
        claimed = true;
        return { run: next } as T;
      }
      if (request.action === "instructions") return { messages: [] } as T;
      if (request.action === "tool") {
        calls++;
        throw new ExecutionError("history_limit", 409);
      }
      if (request.action === "finish") {
        finish(request);
        return { pending: false } as T;
      }
      return {} as T;
    },
    async () => runtime,
  );
  executor.attach("alice", runtime);
  const running = executor.start();
  try {
    expect(await finished).toMatchObject({
      action: "finish",
      status: "failed",
      reason: "history_limit",
    });
    expect(calls).toBe(1);
  } finally {
    executor.close();
    await running;
  }
});
