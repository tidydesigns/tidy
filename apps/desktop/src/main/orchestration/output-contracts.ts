import { z } from "zod";
import { taskStateSchema } from "./task-store";

const id = z.string();
const offset = z.number().nullable();
const task = z
  .object({
    task_id: id,
    child_thread_id: id,
    state: taskStateSchema,
    sequence: z.number(),
    summary: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const toolOutputSchemas = {
  tidy_context: z
    .object({
      project_id: id,
      thread_id: id,
      design_ids: z.array(id),
      writable: z.boolean(),
      current_thread: z
        .object({
          harness: z.string(),
          model: z.string().nullable(),
          reasoning_effort: z.string().nullable(),
          permission_mode: z.string(),
          execution_project_id: id,
        })
        .passthrough(),
    })
    .passthrough(),
  threads_find: z
    .object({
      threads: z.array(
        z.object({ thread_id: id, title: z.string(), status: z.string() }).passthrough(),
      ),
      next_cursor: z.string().nullable(),
    })
    .passthrough(),
  thread_read: z
    .object({
      thread_id: id,
      revision: z.number(),
      messages: z.array(
        z
          .object({
            id,
            role: z.string(),
            text: z.string(),
            truncated: z.boolean(),
            text_offset: z.number(),
            text_length: z.number(),
          })
          .passthrough(),
      ),
      next_after: offset,
      next_text_offset: offset,
      total_messages: z.number(),
    })
    .passthrough(),
  thread_send: task,
  task_delegate: task,
  task_read: z.object({ tasks: z.array(task), cursor: z.number() }).passthrough(),
  task_cancel: task,
  canvas_read: z
    .object({
      design_id: id,
      version: z.string(),
      nodes: z.array(z.object({ id, type: z.string(), name: z.string() }).passthrough()),
      total_nodes: z.number(),
      next_offset: offset,
    })
    .passthrough(),
  canvas_edit: z
    .object({
      design_id: id,
      version: z.string(),
      request_id: id,
      created_node_ids: z.array(id),
      undo_available: z.boolean(),
    })
    .passthrough(),
  canvas_render: z
    .object({ kind: z.enum(["rendered", "unavailable"]), design_id: id, version: z.string() })
    .passthrough(),
};
