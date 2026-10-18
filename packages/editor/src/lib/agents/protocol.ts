import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "recovering",
  "limited",
  "completed",
  "cancelled",
  "failed",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const activeRunStatuses: RunStatus[] = [
  "queued",
  "running",
  "waiting",
  "recovering",
  "limited",
];
export const runLabels: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Needs input",
  recovering: "Reconnecting",
  limited: "Usage limit reached",
  completed: "Complete",
  cancelled: "Stopped",
  failed: "Failed",
};
export const startRunSchema = z
  .object({
    requestId: z.uuid(),
    organizationId: z.string().min(1).max(120),
    threadId: z.uuid().optional(),
    allowOrganizationChanges: z.boolean().default(false),
    prompt: z.string().trim().min(1).max(16000),
    agentLimit: z.number().int().min(1).max(6),
    files: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            selectedNodeIds: z.array(z.string().min(1).max(120)).max(100).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine(
    (value) => new Set(value.files.map((file) => file.id)).size === value.files.length,
    "Attach each file once.",
  );
export type StartRun = z.infer<typeof startRunSchema>;
export const instructionSchema = z
  .object({ requestId: z.uuid(), content: z.string().trim().min(1).max(16000) })
  .strict();
const identifier = z.string().min(1);
const sequence = z.number().int().nonnegative();
// PostgreSQL emits both timestamp text and JSON timestamps; accept either representation.
const timestamp = z.string().min(1);
export const agentMessageSchema = z.object({
  id: identifier,
  runId: identifier.nullable(),
  agentId: identifier.nullable(),
  userId: identifier.nullable(),
  authorName: z.string(),
  isWorker: z.boolean(),
  kind: z.enum(["user", "assistant", "instruction", "question", "system"]),
  content: z.string(),
  delivery: z.enum(["pending", "delivered", "interrupted"]),
  sequence,
  createdAt: timestamp,
});
export const agentWorkerSchema = z.object({
  id: identifier,
  runId: identifier,
  parentId: identifier.nullable(),
  name: z.string(),
  task: z.string(),
  status: z.enum(["queued", "working", "waiting", "completed", "failed", "cancelled"]),
  fileId: identifier.nullable(),
  nodeIds: z.array(identifier),
  heartbeatAt: timestamp.nullable(),
});
export const agentRunSchema = z.object({
  id: identifier,
  threadId: identifier,
  ownerId: identifier,
  ownerName: z.string(),
  agentLimit: z.number().int().positive(),
  model: z.string(),
  status: runStatusSchema,
  reason: z.string().nullable(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export const threadSummarySchema = z.object({
  id: identifier,
  organizationId: identifier,
  title: z.string(),
  updatedAt: timestamp,
  sequence,
  cursor: z.string().optional(),
  files: z.array(
    z.object({ id: identifier, name: z.string(), selectedNodeIds: z.array(identifier) }),
  ),
  run: agentRunSchema.nullable(),
  activeAgents: z.number().int().nonnegative(),
});
export const threadSnapshotSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(agentMessageSchema),
  workers: z.array(agentWorkerSchema),
  hasOlder: z.boolean(),
});
export const threadEventSchema = z.object({
  sequence,
  type: z.string(),
  // Event payloads are intentionally opaque here: the UI refetches the typed snapshot.
  payload: z.record(z.string(), z.unknown()),
});
export const threadListSchema = z.object({ threads: z.array(threadSummarySchema) });
export const threadEventsSchema = z.object({ events: z.array(threadEventSchema) });
export const startedRunSchema = z.object({ runId: identifier, threadId: identifier });
export const steeredRunSchema = z.object({ messageId: identifier });
export const agentOkSchema = z.object({ ok: z.literal(true) });
export const connectionStatusSchema = z.object({
  configured: z.boolean(),
  planSharingConfigured: z.boolean(),
  provider: z.enum(["codex", "chatgpt"]),
  status: z.enum(["disconnected", "connecting", "identity_only", "connected", "reconnect"]),
  accountLabel: z.string().nullable(),
  usageUrl: z.url(),
  helpUrl: z.url(),
});
export const nativeLoginSchema = z.object({
  type: z.literal("chatgptDeviceCode"),
  loginId: z.string().min(1).max(200),
  verificationUrl: z.literal("https://auth.openai.com/codex/device"),
  userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentWorker = z.infer<typeof agentWorkerSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type NativeLogin = z.infer<typeof nativeLoginSchema>;
export const planHelpUrl =
  "https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites";

export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
