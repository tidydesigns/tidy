import type { PullRequestState } from "./pull-request";
import type { ThreadNaming } from "./thread-naming";
import { harnessFailureKindSchema } from "./harness-failure";
import type { RepositoryContext } from "./repository-context";
import type { ThreadPort } from "./thread-ports";
import type { SkillCatalog } from "./skills";
import { z } from "zod";
import { attachmentSchema, type AttachedFile } from "./attachments";
import { toolActivitySchema, MAX_TOOL_ACTIVITIES } from "./tool-activity";
import { approvalRequestSchema, type ApprovalDecision } from "./permissions";
import {
  harnessSettingsSchema,
  tokenUsageSchema,
  type HarnessSettings,
  type HarnessDetails,
} from "./harness-settings";
import type { DesignDocument } from "@tidy/design/document";
import type { AppUpdateState } from "./app-updates";
import {
  queuedMessageSchema,
  MAX_QUEUED_MESSAGES,
  type MessageDelivery,
  type QueueRequest,
} from "./message-queue";
import type { HarnessUpdateState, UpdatableHarnessId } from "./harness-updates";
import type { CloudAPI } from "./cloud-sync";

const id = z.string().uuid();
export const nativeSessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const harnessIdSchema = z.enum(["codex", "claude", "opencode"]);
export const harnessConnectionSchema = z.object({
  id: harnessIdSchema,
  name: z.string(),
  status: z.enum(["ready", "signed-out", "not-installed"]),
});
export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  openedAt: z.string(),
  cloud: z.boolean().optional(),
});
export const folderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  updatedAt: z.string(),
});
export const designSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  updatedAt: z.string(),
  folderId: z.string().uuid().nullable().optional(),
  nodeCount: z.number().optional(),
});

const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(1_000_000),
  sentAt: z.string().datetime().optional(),
  turn: z
    .object({ startedAt: z.string().datetime(), endedAt: z.string().datetime().optional() })
    .optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
});
export const storedThreadSchema = z.object({
  revision: z.number().int().min(0).default(0),
  id,
  projectId: id,
  /** Thread storage/design context; execution may use a separately selected local project. */
  executionProjectId: id.optional(),
  title: z.string().max(120),
  titleSource: z.enum(["prompt", "generated", "manual"]).optional(),
  titleRevision: z.number().int().nonnegative().optional(),
  harness: harnessIdSchema,
  sessionId: nativeSessionIdSchema.optional(),
  settings: harnessSettingsSchema.optional(),
  usage: tokenUsageSchema.optional(),
  actualModel: z.string().max(200).optional(),
  doneAt: z.string().datetime().optional(),
  designIds: z.array(id).max(20),
  messages: z.array(messageSchema).max(1000),
  queuedMessages: z.array(queuedMessageSchema).max(MAX_QUEUED_MESSAGES).optional(),
  queueError: z.string().max(4000).optional(),
  status: z.enum(["idle", "running", "completed", "stopped", "failed", "interrupted"]),
  activity: z.string().max(500).optional(),
  toolActivities: z.array(toolActivitySchema).max(MAX_TOOL_ACTIVITIES).optional(),
  toolActivityTruncated: z.boolean().optional(),
  error: z.string().max(4000).optional(),
  errorKind: harnessFailureKindSchema.optional(),
  updatedAt: z.string().datetime(),
});

export const liveThreadSchema = storedThreadSchema.extend({
  /** Live requests only. Never serialized to thread storage or replayed after restart. */
  pendingApprovals: z.array(approvalRequestSchema).optional(),
});
export const threadSummarySchema = liveThreadSchema
  .omit({
    messages: true,
    sessionId: true,
    toolActivities: true,
    pendingApprovals: true,
    queuedMessages: true,
    queueError: true,
  })
  .extend({
    pendingApprovalCount: z.number().int().nonnegative().optional(),
    preview: z.string().optional(),
    messageCount: z.number().int().nonnegative().optional(),
    queuedMessageCount: z.number().int().nonnegative().optional(),
  });
export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread-summary"), thread: threadSummarySchema }),
  z.object({ type: z.literal("thread"), thread: liveThreadSchema }),
  z.object({
    type: z.literal("thread-patch"),
    thread: liveThreadSchema.omit({
      messages: true,
      toolActivities: true,
      queuedMessages: true,
      queueError: true,
    }),
    summary: threadSummarySchema,
    messages: z.array(messageSchema),
    toolActivities: z.array(toolActivitySchema),
    toolActivityIds: z.array(id),
  }),
  z.object({
    type: z.literal("designs"),
    projectId: id,
    designs: z.array(designSchema),
    folders: z.array(folderSchema),
  }),
]);

export type HarnessId = z.infer<typeof harnessIdSchema>;
export type HarnessConnection = z.infer<typeof harnessConnectionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Thread = z.infer<typeof liveThreadSchema>;
export type Message = Thread["messages"][number];
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type DesignFolder = z.infer<typeof folderSchema>;
export type DesignSummary = z.infer<typeof designSchema>;
export type LocalDesign = DesignSummary & {
  document: DesignDocument;
  version: string;
  assets: Record<string, string>;
};
export type ProjectSnapshot = {
  project: Project;
  threads: ThreadSummary[];
  designs: DesignSummary[];
  folders: DesignFolder[];
};
export type Bootstrap = {
  projects: Project[];
  activeProject: ProjectSnapshot | null;
  harnesses: HarnessConnection[];
};
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type DesktopAPI = {
  browser?: import("./browser").BrowserAPI;
  projectDirectories?(path: string): Promise<import("./browser-directory").Directory>;
  projectCheckouts?(projectId?: string): Promise<import("./project-setup").ProjectCheckout[]>;
  setupProject?(
    input: import("./project-setup").ProjectSetup,
  ): Promise<import("./workspace-response").ProjectSetupResult>;
  exportAttachment?(
    projectId: string,
    attachmentId: string,
  ): Promise<{ name: string; dataUrl: string }>;
  exportDesign?(projectId: string, designId: string): Promise<LocalDesign>;
  importDraft?(
    input: import("./draft-import").DraftImport,
  ): Promise<import("./workspace-response").WorkspaceResponse<"import-draft">>;
  reloadApp?(): Promise<void>;
  analytics?: import("@tidy/design/analytics").AnalyticsAPI;
  /** The native window controls overlay the renderer on macOS. Absent in browser development. */
  readonly customTitlebar?: boolean;
  /** Native window notifications; absent in browser development. */
  onWindowFullscreen?(listener: (fullscreen: boolean) => void): () => void;
  harnessUpdates(): Promise<HarnessUpdateState[]>;
  installHarnessUpdate(id: UpdatableHarnessId): Promise<void>;
  onHarnessUpdates(listener: (state: HarnessUpdateState[]) => void): () => void;
  cloud?: CloudAPI;
  updateState(): Promise<AppUpdateState>;
  checkUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdate(listener: (state: AppUpdateState) => void): () => void;
  bootstrap(): Promise<Bootstrap>;
  projectSnapshot?(projectId: string): Promise<ProjectSnapshot>;
  openProject(): Promise<ProjectSnapshot | null>;
  selectProject(projectId: string): Promise<ProjectSnapshot>;
  removeProject?(projectId: string): Promise<void>;
  checkHarnesses(): Promise<HarnessConnection[]>;
  repositoryContext(projectId: string): Promise<RepositoryContext>;
  switchBranch(
    projectId: string,
    branch: string,
  ): Promise<import("./repository-context").BranchSwitchResult>;
  skills(projectId: string, harness: HarnessId, refresh?: boolean): Promise<SkillCatalog>;
  harnessDetails(projectId: string, harness: HarnessId, refresh?: boolean): Promise<HarnessDetails>;
  harnessUsage?(
    projectId: string,
    harness: HarnessId,
    refresh?: boolean,
  ): Promise<import("./harness-usage").HarnessUsage>;
  openHarnessUsage(harness: HarnessId, page: "subscription" | "api"): Promise<void>;
  readVideoChunk(
    input: import("./video-preview").VideoChunkRequest,
  ): Promise<import("./video-preview").VideoChunk>;
  openChatLink(projectId: string, href: string): Promise<void>;
  pullRequestState?(projectId: string, href: string): Promise<PullRequestState | null>;
  setThreadSettings(
    projectId: string,
    threadId: string,
    settings: HarnessSettings,
  ): Promise<Thread>;
  renameThread(projectId: string, threadId: string, title: string): Promise<Thread>;
  regenerateThreadTitle(projectId: string, threadId: string, naming: ThreadNaming): Promise<Thread>;
  readThread(projectId: string, threadId: string): Promise<Thread>;
  startThread(input: {
    threadId?: string;
    messageId?: string;
    projectId: string;
    executionProjectId?: string;
    harness: HarnessId;
    prompt: string;
    naming?: ThreadNaming;
    designIds: string[];
    settings?: HarnessSettings;
    attachmentIds?: string[];
    skillId?: string;
  }): Promise<Thread>;
  warmThread?(
    input: Pick<
      Parameters<DesktopAPI["startThread"]>[0],
      "projectId" | "executionProjectId" | "harness" | "settings" | "threadId"
    >,
  ): Promise<void>;
  sendMessage(input: {
    delivery?: MessageDelivery;
    messageId?: string;
    projectId: string;
    threadId: string;
    text: string;
    attachmentIds?: string[];
    skillId?: string;
  }): Promise<Thread>;
  updateMessageQueue(input: QueueRequest): Promise<Thread>;
  addAttachment(projectId: string, name: string, dataUrl: string): Promise<AttachedFile>;
  readAttachment(projectId: string, attachmentId: string): Promise<AttachedFile>;
  setThreadDone(projectId: string, threadId: string, done: boolean): Promise<Thread>;
  stopThread(projectId: string, threadId: string): Promise<void>;
  threadPorts(projectId: string, threadId: string): Promise<ThreadPort[]>;
  stopThreadPort(projectId: string, threadId: string, portId: string): Promise<void>;
  respondToApproval(
    projectId: string,
    threadId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<Thread>;
  createDesign(projectId: string, folderId?: string | null): Promise<LocalDesign>;
  importDesign(projectId: string, folderId?: string | null): Promise<LocalDesign | null>;
  createDesignFolder(projectId: string, name: string): Promise<DesignFolder>;
  renameDesignFolder(projectId: string, folderId: string, name: string): Promise<DesignFolder>;
  readDesign(projectId: string, designId: string): Promise<LocalDesign>;
  previewDesign(projectId: string, designId: string): Promise<LocalDesign>;
  refreshDesign(projectId: string, designId: string, version: string): Promise<LocalDesign | null>;
  updateDesign(input: {
    projectId: string;
    designId: string;
    expectedVersion: string;
    document?: DesignDocument;
    name?: string;
    folderId?: string | null;
  }): Promise<LocalDesign>;
  uploadDesignAsset(projectId: string, dataUrl: string): Promise<{ assetId: string; url: string }>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
};
