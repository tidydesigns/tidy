import { z } from "zod";
import { harnessIdSchema } from "./desktop";

export const taskStateSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const threadTasksRequestSchema = z
  .object({
    projectId: z.uuid(),
    threadId: z.uuid(),
    before: z.number().int().positive().optional(),
    taskIds: z.array(z.uuid()).min(1).max(50).optional(),
  })
  .strict()
  .refine(
    (input) => !(input.before !== undefined && input.taskIds),
    "Choose a history cursor or task IDs.",
  );
export const threadTaskSchema = z.object({
  id: z.uuid(),
  childThreadId: z.uuid(),
  originatingMessageId: z.uuid().optional(),
  sequence: z.number().int().nonnegative(),
  label: z.string().max(160),
  state: taskStateSchema,
  kind: z.enum(["initial", "followup", "message"]),
  harness: harnessIdSchema,
  model: z.string().max(200).optional(),
  effort: z.string().max(40).optional(),
  createdAt: z.string().datetime(),
  summary: z.string().max(1000).optional(),
  error: z.string().max(1000).optional(),
});
export const threadTasksPageSchema = z.object({
  tasks: z.array(threadTaskSchema).max(50),
  nextCursor: z.number().int().positive().nullable(),
});
export const threadTasksSchema = threadTasksPageSchema.extend({
  parent: z.object({ threadId: z.uuid(), title: z.string().max(120) }).nullable(),
});
export type ThreadTask = z.infer<typeof threadTaskSchema>;
export type ThreadTasks = z.infer<typeof threadTasksSchema>;
export type ThreadTasksRequest = z.infer<typeof threadTasksRequestSchema>;
