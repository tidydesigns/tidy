import { chooseBrowserProject } from "./browser-project-picker";
import type { Bootstrap, DesktopAPI, DesktopEvent } from "../../shared/contracts";

// A previously authenticated browser can open the private link again.
if (new URLSearchParams(location.hash.slice(1)).has("token"))
  history.replaceState(null, "", location.pathname + location.search);

async function request<T>(
  name: string,
  input?: unknown,
  file?: { name: string; document: unknown },
  projectPath?: string,
): Promise<T> {
  const response = await fetch("/__tidy/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, input, file, projectPath }),
  });
  if (response.status === 401)
    throw new Error("Your development session expired. Open the development link again.");
  const result = (await response.json()) as { ok: true; data: T } | { ok: false; error: string };
  if (!result.ok) throw new Error(result.error);
  return result.data;
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
  return request<Awaited<ReturnType<DesktopAPI["importDesign"]>>>(
    "import-design",
    { projectId, folderId },
    {
      name: file.name.replace(/\.json$/i, ""),
      document: JSON.parse(await file.text()) as unknown,
    },
  );
}

const api: DesktopAPI = {
  bootstrap: () => request("bootstrap"),
  openProject: () =>
    chooseBrowserProject((path) => request("open-project", undefined, undefined, path)),
  selectProject: (projectId) => request("select-project", projectId),
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
    events.addEventListener("resync", () => {
      void request<Bootstrap>("bootstrap")
        .then(async ({ activeProject }) => {
          if (!activeProject) return;
          listener({
            type: "designs",
            projectId: activeProject.project.id,
            designs: activeProject.designs,
            folders: activeProject.folders,
          });
          for (const summary of activeProject.threads) {
            const thread = await api.readThread(activeProject.project.id, summary.id);
            listener({ type: "thread", thread });
          }
        })
        .catch(console.error);
    });
    events.onmessage = (message) => listener(JSON.parse(message.data) as DesktopEvent);
    return () => events.close();
  },
};

window.tidy = api;
