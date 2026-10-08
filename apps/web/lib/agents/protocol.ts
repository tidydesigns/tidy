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
export type AgentMessage = {
  id: string;
  runId: string | null;
  agentId: string | null;
  userId: string | null;
  authorName: string;
  isWorker: boolean;
  kind: "user" | "assistant" | "instruction" | "question" | "system";
  content: string;
  delivery: "pending" | "delivered" | "interrupted";
  sequence: number;
  createdAt: string;
};
export type AgentWorker = {
  id: string;
  runId: string;
  parentId: string | null;
  name: string;
  task: string;
  status: "queued" | "working" | "waiting" | "completed" | "failed" | "cancelled";
  fileId: string | null;
  nodeIds: string[];
  heartbeatAt: string | null;
};
export type AgentRun = {
  id: string;
  threadId: string;
  ownerId: string;
  ownerName: string;
  agentLimit: number;
  model: string;
  status: RunStatus;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type ThreadSummary = {
  id: string;
  organizationId: string;
  title: string;
  updatedAt: string;
  sequence: number;
  cursor?: string;
  files: { id: string; name: string; selectedNodeIds: string[] }[];
  run: AgentRun | null;
  activeAgents: number;
};
export type ThreadSnapshot = {
  thread: ThreadSummary;
  messages: AgentMessage[];
  workers: AgentWorker[];
  hasOlder: boolean;
};
export type ThreadEvent = { sequence: number; type: string; payload: Record<string, unknown> };
export type ConnectionStatus = {
  configured: boolean;
  planSharingConfigured: boolean;
  provider: "codex" | "chatgpt";
  status: "disconnected" | "connecting" | "identity_only" | "connected" | "reconnect";
  accountLabel: string | null;
  usageUrl: string;
  helpUrl: string;
};
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
