import type { ToolActivity } from "./tool-activity";
import type { ApprovalRequest, ApprovalDecision } from "./permissions";
import type { Attachment, AttachedFile } from "./attachments";
import type { HarnessSettings, HarnessDetails, TokenUsage } from "./harness-settings";
import type { DesignDocument } from "@tidy/design/document";

export type HarnessId = "codex" | "claude";
export type HarnessConnection = {
  id: HarnessId;
  name: string;
  status: "ready" | "signed-out" | "not-installed";
};
export type Project = { id: string; name: string; path: string; openedAt: string };
export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
};
export type Thread = {
  revision: number;
  id: string;
  projectId: string;
  title: string;
  harness: HarnessId;
  settings?: HarnessSettings;
  usage?: TokenUsage;
  actualModel?: string;
  sessionId?: string;
  doneAt?: string;
  designIds: string[];
  messages: Message[];
  status: "idle" | "running" | "completed" | "stopped" | "failed" | "interrupted";
  activity?: string;
  toolActivities?: ToolActivity[];
  toolActivityTruncated?: boolean;
  /** Live requests only. Never serialized to thread storage or replayed after restart. */
  pendingApprovals?: ApprovalRequest[];
  error?: string;
  updatedAt: string;
};
export type ThreadSummary = Omit<
  Thread,
  "messages" | "sessionId" | "toolActivities" | "pendingApprovals"
> & {
  pendingApprovalCount?: number;
  preview?: string;
  messageCount?: number;
};
export function summarizeThread(thread: Thread): ThreadSummary {
  return {
    revision: thread.revision,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    harness: thread.harness,
    doneAt: thread.doneAt,
    settings: thread.settings,
    actualModel: thread.actualModel,
    usage: thread.usage,
    preview: thread.messages
      .slice()
      .reverse()
      .find((message) => message.role === "assistant")
      ?.text.slice(0, 320),
    messageCount: thread.messages.length,
    designIds: thread.designIds,
    status: thread.status,
    activity: thread.activity,
    pendingApprovalCount: thread.pendingApprovals?.length,
    error: thread.error,
    updatedAt: thread.updatedAt,
  };
}
export type DesignFolder = { id: string; name: string; updatedAt: string };
export type DesignSummary = {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
  folderId?: string | null;
  nodeCount?: number;
};
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
export type DesktopEvent =
  | { type: "thread"; thread: Thread }
  | { type: "designs"; projectId: string; designs: DesignSummary[]; folders: DesignFolder[] };
export type DesktopAPI = {
  bootstrap(): Promise<Bootstrap>;
  openProject(): Promise<ProjectSnapshot | null>;
  selectProject(projectId: string): Promise<ProjectSnapshot>;
  checkHarnesses(): Promise<HarnessConnection[]>;
  harnessDetails(projectId: string, harness: HarnessId, refresh?: boolean): Promise<HarnessDetails>;
  openHarnessUsage(harness: HarnessId, page: "subscription" | "api"): Promise<void>;
  setThreadSettings(
    projectId: string,
    threadId: string,
    settings: HarnessSettings,
  ): Promise<Thread>;
  readThread(projectId: string, threadId: string): Promise<Thread>;
  startThread(input: {
    projectId: string;
    harness: HarnessId;
    prompt: string;
    designIds: string[];
    settings?: HarnessSettings;
    attachmentIds?: string[];
  }): Promise<Thread>;
  sendMessage(input: {
    projectId: string;
    threadId: string;
    text: string;
    attachmentIds?: string[];
  }): Promise<Thread>;
  addAttachment(projectId: string, name: string, dataUrl: string): Promise<AttachedFile>;
  readAttachment(projectId: string, attachmentId: string): Promise<AttachedFile>;
  setThreadDone(projectId: string, threadId: string, done: boolean): Promise<Thread>;
  stopThread(projectId: string, threadId: string): Promise<void>;
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
