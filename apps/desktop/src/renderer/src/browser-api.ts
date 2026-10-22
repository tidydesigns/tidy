import { chooseBrowserProject } from "./browser-project-picker";
import { desktopEventSchema } from "../../shared/contracts";
import { browserRecovery } from "../../shared/browser-recovery";
import {
  parseWorkspaceResponse,
  type WorkspaceOperation,
  type WorkspaceResponse,
} from "../../shared/workspace-response";
import type { DesktopAPI, ProjectSnapshot } from "../../shared/contracts";

if (new URLSearchParams(location.hash.slice(1)).has("token"))
  history.replaceState(null, "", location.pathname + location.search);

async function request<Name extends WorkspaceOperation>(
  name: Name,
  input?: unknown,
  file?: { name: string; document: unknown },
  projectPath?: string,
): Promise<WorkspaceResponse<Name>> {
  const response = await fetch("/__tidy/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, input, file, projectPath }),
  });
  if (response.status === 401)
    throw new Error("Your development session expired. Open the development link again.");
  return parseWorkspaceResponse(name, await response.json());
}

async function importDesign(projectId: string, folderId?: string | null) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
  if (!file) return null;
  if (file.size > 16 * 1024 * 1024) throw new Error("The design file is too large.");
  return request(
    "import-design",
    { projectId, folderId },
    {
      name: file.name.replace(/\.json$/i, ""),
      document: JSON.parse(await file.text()) as unknown,
    },
  );
}

const recoveries = new Set<ReturnType<typeof browserRecovery>>();
function remember<T extends ProjectSnapshot | null>(snapshot: T): T {
  for (const recovery of recoveries) recovery.remember(snapshot);
  return snapshot;
}

const api: DesktopAPI = {
  updateState: async () => ({ status: "unsupported" }),
  checkUpdates: async () => {},
  installUpdate: async () => {
    throw new Error("Updates require the installed desktop app.");
  },
  onUpdate: () => () => {},
  bootstrap: async () => {
    const value = await request("bootstrap");
    remember(value.activeProject);
    return value;
  },
  openProject: () =>
    chooseBrowserProject(async (path) => {
      const value = await request("open-project", undefined, undefined, path);
      if (!value) throw new Error("No project was selected.");
      return remember(value);
    }),
  selectProject: (projectId) => request("select-project", projectId).then(remember),
  harnessDetails: (projectId, harness, refresh) =>
    request("harness-details", { projectId, harness, refresh }),
  async openHarnessUsage(harness, page) {
    const urls = {
      codex: {
        api: "https://platform.openai.com/usage",
        subscription: "https://chatgpt.com/codex/settings/usage",
      },
      claude: {
        api: "https://platform.claude.com/usage",
        subscription: "https://claude.ai/settings/usage",
      },
    };
    window.open(urls[harness][page], "_blank", "noopener,noreferrer");
  },
  setThreadSettings: (projectId, threadId, settings) =>
    request("thread-settings", { projectId, threadId, settings }),
  checkHarnesses: () => request("harnesses"),
  readThread: (projectId, threadId) => request("read-thread", { projectId, threadId }),
  startThread: (input) => request("start-thread", input),
  sendMessage: (input) => request("send-message", input),
  updateMessageQueue: (input) => request("message-queue", input),
  addAttachment: (projectId, name, dataUrl) =>
    request("add-attachment", { projectId, name, dataUrl }),
  readAttachment: (projectId, attachmentId) =>
    request("read-attachment", { projectId, attachmentId }),
  setThreadDone: (projectId, threadId, done) =>
    request("set-thread-done", { projectId, threadId, done }),
  respondToApproval: (projectId, threadId, approvalId, decision) =>
    request("respond-approval", { projectId, threadId, approvalId, decision }),
  stopThread: (projectId, threadId) => request("stop-thread", { projectId, threadId }),
  createDesign: (projectId, folderId) => request("create-design", { projectId, folderId }),
  importDesign,
  createDesignFolder: (projectId, name) => request("create-design-folder", { projectId, name }),
  renameDesignFolder: (projectId, folderId, name) =>
    request("rename-design-folder", { projectId, folderId, name }),
  readDesign: (projectId, designId) => request("read-design", { projectId, designId }),
  updateDesign: (input) => request("update-design", input),
  uploadDesignAsset: (projectId, dataUrl) => request("upload-design-asset", { projectId, dataUrl }),
  onEvent(listener) {
    const events = new EventSource("/__tidy/events");
    const recovery = browserRecovery({
      bootstrap: () => request("bootstrap"),
      snapshot: (id) => request("project-snapshot", id),
      readThread: api.readThread,
      listener,
      onError: (error) => console.error("Browser project recovery failed", error),
    });
    recoveries.add(recovery);
    events.addEventListener("resync", () => void recovery.refresh());
    events.onmessage = (message) => {
      try {
        recovery.receive(desktopEventSchema.parse(JSON.parse(message.data)));
      } catch (error) {
        console.error("Invalid browser workspace event", error);
        void recovery.refresh();
      }
    };
    return () => {
      recovery.close();
      recoveries.delete(recovery);
      events.close();
    };
  },
};

window.tidy = api;
