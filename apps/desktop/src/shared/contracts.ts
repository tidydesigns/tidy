import type { DesignDocument } from "@bella/design/document";

export type HarnessId = "codex" | "claude";
export type HarnessConnection = {
  id: HarnessId;
  name: string;
  status: "ready" | "signed-out" | "not-installed";
};
export type Project = { id: string; name: string; path: string; openedAt: string };
export type Message = { id: string; role: "user" | "assistant"; text: string };
export type Thread = {
  revision: number;
  id: string;
  projectId: string;
  title: string;
  harness: HarnessId;
  sessionId?: string;
  designIds: string[];
  messages: Message[];
  status: "idle" | "running" | "completed" | "stopped" | "failed" | "interrupted";
  activity?: string;
  error?: string;
  updatedAt: string;
};
export type ThreadSummary = Omit<Thread, "messages" | "sessionId">;
export function summarizeThread(thread: Thread): ThreadSummary {
  return {
    revision: thread.revision,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    harness: thread.harness,
    designIds: thread.designIds,
    status: thread.status,
    activity: thread.activity,
    error: thread.error,
    updatedAt: thread.updatedAt,
  };
}
export type DesignSummary = { id: string; name: string; path: string; updatedAt: string };
export type LocalDesign = DesignSummary & { document: DesignDocument };
export type ProjectSnapshot = {
  project: Project;
  threads: ThreadSummary[];
  designs: DesignSummary[];
};
export type Bootstrap = {
  projects: Project[];
  activeProject: ProjectSnapshot | null;
  harnesses: HarnessConnection[];
};
export type DesktopEvent =
  | { type: "thread"; thread: Thread }
  | { type: "designs"; projectId: string; designs: DesignSummary[] };
export type DesktopAPI = {
  bootstrap(): Promise<Bootstrap>;
  openProject(): Promise<ProjectSnapshot | null>;
  selectProject(projectId: string): Promise<ProjectSnapshot>;
  checkHarnesses(): Promise<HarnessConnection[]>;
  readThread(projectId: string, threadId: string): Promise<Thread>;
  startThread(input: {
    projectId: string;
    harness: HarnessId;
    prompt: string;
    designIds: string[];
  }): Promise<Thread>;
  sendMessage(input: { projectId: string; threadId: string; text: string }): Promise<Thread>;
  stopThread(projectId: string, threadId: string): Promise<void>;
  createDesign(projectId: string): Promise<LocalDesign>;
  importDesign(projectId: string): Promise<LocalDesign | null>;
  readDesign(projectId: string, designId: string): Promise<LocalDesign>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
};
