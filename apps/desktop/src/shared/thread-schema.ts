import { z } from "zod";
import { attachmentSchema } from "./attachments";
import { toolActivitySchema, MAX_TOOL_ACTIVITIES } from "./tool-activity";
import { harnessSettingsSchema, tokenUsageSchema } from "./harness-settings";
import { approvalDecisionSchema } from "./permissions";

const id = z.string().uuid();
const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(1_000_000),
  attachments: z.array(attachmentSchema).max(10).optional(),
});
export const storedThreadSchema = z.object({
  revision: z.number().int().min(0).default(0),
  id,
  projectId: id,
  title: z.string().max(120),
  harness: z.enum(["codex", "claude"]),
  sessionId: id.optional(),
  settings: harnessSettingsSchema.optional(),
  usage: tokenUsageSchema.optional(),
  actualModel: z.string().max(200).optional(),
  doneAt: z.string().datetime().optional(),
  designIds: z.array(id).max(20),
  messages: z.array(messageSchema).max(1000),
  status: z.enum(["idle", "running", "completed", "stopped", "failed", "interrupted"]),
  activity: z.string().max(500).optional(),
  toolActivities: z.array(toolActivitySchema).max(MAX_TOOL_ACTIVITIES).optional(),
  toolActivityTruncated: z.boolean().optional(),
  error: z.string().max(4000).optional(),
  updatedAt: z.string().datetime(),
});

export const liveThreadSchema = storedThreadSchema.extend({
  /** Live requests only. Never serialized to thread storage or replayed after restart. */
  pendingApprovals: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        reason: z.string().optional(),
        details: z.string().optional(),
        shortened: z.boolean().optional(),
        choices: z.array(approvalDecisionSchema),
        scope: z.literal("turn").optional(),
      }),
    )
    .optional(),
});
export const threadSummarySchema = liveThreadSchema
  .omit({
    messages: true,
    sessionId: true,
    toolActivities: true,
    pendingApprovals: true,
  })
  .extend({
    pendingApprovalCount: z.number().int().nonnegative().optional(),
    preview: z.string().optional(),
    messageCount: z.number().int().nonnegative().optional(),
  });
export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread"), thread: liveThreadSchema }),
  z.object({
    type: z.literal("thread-patch"),
    thread: liveThreadSchema.omit({ messages: true, toolActivities: true }),
    summary: threadSummarySchema,
    messages: z.array(messageSchema),
    toolActivities: z.array(toolActivitySchema),
    toolActivityIds: z.array(id),
  }),
  z.object({
    type: z.literal("designs"),
    projectId: id,
    designs: z.array(
      z.object({
        id,
        name: z.string(),
        path: z.string(),
        updatedAt: z.string(),
        folderId: id.nullable().optional(),
        nodeCount: z.number().optional(),
      }),
    ),
    folders: z.array(z.object({ id, name: z.string(), updatedAt: z.string() })),
  }),
]);
