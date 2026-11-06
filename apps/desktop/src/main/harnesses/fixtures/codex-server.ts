#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";

const record = z.record(z.string(), z.unknown());
const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: record.optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const threadParams = z.object({ threadId: z.string() });
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const threads = new Map<string, { model: unknown; turnId?: string; stubborn?: boolean }>();
const approvals = new Map<string, string>();
let serial = 0;
let initialized = false;
const notify = (method: string, params: unknown) => send({ method, params });
function finish(threadId: string, status = "completed") {
  const thread = threads.get(threadId);
  if (!thread?.turnId) return;
  notify("turn/completed", { threadId, turn: { id: thread.turnId, status } });
  thread.turnId = undefined;
}
function text(threadId: string, delta: string) {
  notify("item/agentMessage/delta", {
    threadId,
    turnId: threads.get(threadId)?.turnId,
    itemId: "message",
    delta,
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = messageSchema.parse(JSON.parse(line));
  appendFileSync("codex-events.jsonl", JSON.stringify({ pid: process.pid, ...message }) + "\n");
  const reply = (result: unknown) => send({ id: message.id, result });
  const reject = (reason: string) =>
    send({ id: message.id, error: { code: -32602, message: reason } });
  if (message.method === "initialize") {
    if (initialized || existsSync("fail-initialize")) reject("Initialize failed");
    else {
      initialized = true;
      reply({});
    }
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    if (message.params?.model === "reject-thread") {
      reject("Thread initialization failed");
      continue;
    }
    const id =
      message.method === "thread/start"
        ? randomUUID()
        : threadParams.parse(message.params).threadId;
    threads.set(id, { model: message.params?.model });
    reply({ thread: { id }, model: message.params?.model ?? "fixture-model" });
  } else if (message.method === "thread/unsubscribe") {
    reply({ status: "unsubscribed" });
  } else if (message.method === "turn/start") {
    const { threadId } = threadParams.parse(message.params);
    const thread = threads.get(threadId);
    if (!thread) throw new Error("Unknown thread");
    const input = JSON.stringify(message.params?.input);
    if (input.includes("crash")) process.exit(1);
    thread.turnId = `turn-${++serial}`;
    thread.stubborn = input.includes("stubborn");
    if (input.includes("hang-start")) continue;
    reply({ turn: { id: thread.turnId } });
    notify("turn/started", { threadId, turn: { id: thread.turnId } });
    if (input.includes("approve")) {
      const id = `approval-${serial}`;
      approvals.set(id, threadId);
      send({
        id,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId: thread.turnId,
          itemId: "command",
          command: `echo ${threadId}`,
        },
      });
      if (input.includes("resolved")) {
        notify("serverRequest/resolved", { requestId: id });
        finish(threadId);
      }
    } else if (input.includes("foreign")) {
      send({
        id: "foreign-request",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: randomUUID(),
          turnId: thread.turnId,
          itemId: "command",
          command: "echo foreign",
        },
      });
      text(threadId, "owned");
      finish(threadId);
    } else if (input.includes("stream")) {
      const count = input.includes("flood") ? 2000 : 30;
      let index = 0;
      const timer = setInterval(
        () => {
          if (!thread.turnId) {
            clearInterval(timer);
            return;
          }
          text(threadId, `${index++},`);
          if (index === count) {
            clearInterval(timer);
            finish(threadId);
          }
        },
        input.includes("flood") ? 0 : 2,
      );
    } else if (!input.includes("hold") && !thread.stubborn) {
      text(threadId, String(thread.model ?? "fixture-model"));
      finish(threadId);
    }
  } else if (message.method === "turn/interrupt") {
    const { threadId } = threadParams.parse(message.params);
    if (threads.get(threadId)?.stubborn) continue;
    reply({});
    finish(threadId, "interrupted");
  } else if (message.method === "turn/steer") {
    const { threadId } = threadParams.parse(message.params);
    text(threadId, "steered");
    reply({});
    finish(threadId);
  } else if (typeof message.id === "string" && approvals.has(message.id)) {
    const threadId = approvals.get(message.id);
    approvals.delete(message.id);
    if (threadId) {
      text(threadId, "approved");
      finish(threadId);
    }
  }
}
