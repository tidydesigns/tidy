import { z } from "zod";

export type AgentScope = {
  projectId: string;
  threadId: string;
  designIds: string[];
  writable: boolean;
  signal: AbortSignal;
};

export class AgentOperationError extends Error {
  constructor(
    readonly code:
      | "FORBIDDEN"
      | "CONFLICT"
      | "BUSY"
      | "NOT_FOUND"
      | "UNAVAILABLE"
      | "INVALID_CURSOR",
    message: string,
  ) {
    super(message);
  }
}

export const requestId = z.string().uuid();
export const entityId = z.string().uuid();
export const pageSize = z.number().int().min(1).max(100).default(30);
export const threadFindSchema = z
  .object({
    query: z.string().max(200).default(""),
    cursor: z.string().max(2000).optional(),
    limit: pageSize,
  })
  .strict();
export const threadReadSchema = z
  .object({
    thread_id: entityId,
    after: z.number().int().nonnegative().default(0),
    text_offset: z.number().int().nonnegative().default(0),
    text_limit: z.number().int().min(1).max(16_000).default(16_000),
    limit: pageSize,
  })
  .strict();
export const threadSendSchema = z
  .object({
    thread_id: entityId,
    request_id: requestId,
    message: z.string().trim().min(1).max(16_000),
  })
  .strict();
export const taskDelegateSchema = z
  .object({
    request_id: requestId,
    prompt: z.string().trim().min(1).max(16_000),
    harness: z.enum(["codex", "claude", "opencode"]).optional(),
    model: z.string().min(1).max(200).optional(),
    design_ids: z.array(entityId).max(20).optional(),
  })
  .strict();
export const taskReadSchema = z
  .object({
    task_ids: z.array(entityId).min(1).max(30).optional(),
    after: z.number().int().nonnegative().default(0),
    limit: pageSize,
  })
  .strict();
export const taskCancelSchema = z.object({ task_id: entityId }).strict();
