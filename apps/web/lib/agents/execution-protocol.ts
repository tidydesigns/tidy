import { z } from "zod";
import type { StartRun } from "./protocol";

export type DynamicTool = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ExecutionWorker = {
  id: string;
  parentId: string | null;
  name: string;
  task: string;
  runtimeThreadId: string | null;
};
export type ExecutionRun = {
  id: string;
  threadId: string;
  organizationId: string;
  owner: string;
  generation: number;
  model: string;
  agentLimit: number;
  allowOrganizationChanges: boolean;
  files: StartRun["files"];
  workers: ExecutionWorker[];
  messages: { kind: string; content: string; authorName: string }[];
  tools: DynamicTool[];
};
const lease = { runId: z.uuid(), generation: z.number().int().nonnegative() };
const worker = { ...lease, agentId: z.uuid() };
export const executionRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), runnerId: z.uuid() }).strict(),
  z.object({ action: z.literal("heartbeat"), ...lease }).strict(),
  z
    .object({ action: z.literal("bind"), ...worker, runtimeThreadId: z.string().min(1).max(200) })
    .strict(),
  z
    .object({
      action: z.literal("message"),
      ...worker,
      id: z.uuid(),
      content: z.string().max(64000),
      kind: z.enum(["assistant", "question"]).default("assistant"),
    })
    .strict(),
  z
    .object({
      action: z.literal("worker"),
      ...worker,
      status: z.enum(["working", "waiting", "completed", "failed"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("spawn"),
      ...worker,
      callId: z.string().min(1).max(200),
      name: z.string().min(1).max(80),
      task: z.string().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      action: z.literal("tool"),
      ...worker,
      callId: z.string().min(1).max(200),
      tool: z.string().min(1).max(100),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal("instructions"),
      ...lease,
      delivered: z.array(z.uuid()).max(100).default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("finish"),
      ...lease,
      status: z.enum(["completed", "failed", "limited", "waiting"]),
      reason: z.enum([
        "complete",
        "provider_error",
        "usage_limit",
        "connection_required",
        "needs_input",
        "runner_disconnected",
        "history_limit",
      ]),
    })
    .strict(),
]);
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
