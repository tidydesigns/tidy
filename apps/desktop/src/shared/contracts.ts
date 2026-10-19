import type { z } from "zod";
import type { liveThreadSchema, threadSummarySchema, desktopEventSchema } from "./thread-schema";
import type { ApprovalDecision } from "./permissions";
import type { AttachedFile } from "./attachments";
import type { HarnessSettings, HarnessDetails } from "./harness-settings";
import type { DesignDocument } from "@tidy/design/document";

export type HarnessId = "codex" | "claude";
export type HarnessConnection = {
  id: HarnessId;
  name: string;
  status: "ready" | "signed-out" | "not-installed";
};
export type Project = { id: string; name: string; path: string; openedAt: string };
export type Thread = z.infer<typeof liveThreadSchema>;
export type Message = Thread["messages"][number];
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
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
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
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
    threadId?: string;
    messageId?: string;
    projectId: string;
    harness: HarnessId;
    prompt: string;
    designIds: string[];
    settings?: HarnessSettings;
    attachmentIds?: string[];
  }): Promise<Thread>;
  sendMessage(input: {
    messageId?: string;
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
