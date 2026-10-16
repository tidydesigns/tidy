import { z } from "zod";
import { startRunSchema } from "./protocol";

const dynamicToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type DynamicTool = z.infer<typeof dynamicToolSchema>;
export const executionWorkerSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  name: z.string(),
  task: z.string(),
  runtimeThreadId: z.string().nullable(),
});
export type ExecutionWorker = z.infer<typeof executionWorkerSchema>;
export const executionRunSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  organizationId: z.string().min(1),
  owner: z.string().min(1),
  generation: z.number().int().nonnegative(),
  model: z.string().min(1),
  agentLimit: z.number().int().min(1).max(6),
  allowOrganizationChanges: z.boolean(),
  // Execution scope can grow when a run creates files; the admission cap applies only at start.
  files: z.array(startRunSchema.shape.files.element).min(1),
  workers: z.tuple([executionWorkerSchema], executionWorkerSchema),
  messages: z.array(z.object({ kind: z.string(), content: z.string(), authorName: z.string() })),
  tools: z.array(dynamicToolSchema),
});
export type ExecutionRun = z.infer<typeof executionRunSchema>;
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
