import { contextBridge, ipcRenderer } from "electron";
import {
  parseWorkspaceResponse,
  type WorkspaceOperation,
  type WorkspaceResponse,
} from "../shared/workspace-response";
import { desktopEventSchema } from "../shared/contracts";
import type { DesktopAPI } from "../shared/contracts";
import { appUpdateStateSchema } from "../shared/app-updates";

async function request<Name extends WorkspaceOperation>(
  name: Name,
  input?: unknown,
): Promise<WorkspaceResponse<Name>> {
  return parseWorkspaceResponse(name, await ipcRenderer.invoke(`tidy:${name}`, input));
}

const api: DesktopAPI = {
  updateState: async () =>
    appUpdateStateSchema.parse(await ipcRenderer.invoke("tidy:update-state")),
  installUpdate: async () => {
    await ipcRenderer.invoke("tidy:install-update");
  },
  onUpdate(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(appUpdateStateSchema.parse(value));
    ipcRenderer.on("tidy:update", receive);
    return () => {
      ipcRenderer.removeListener("tidy:update", receive);
    };
  },
  bootstrap: () => request("bootstrap"),
  openProject: () => request("open-project"),
  selectProject: (projectId) => request("select-project", projectId),
  harnessDetails: (projectId, harness, refresh) =>
    request("harness-details", { projectId, harness, refresh }),
  openHarnessUsage: (harness, page) => request("harness-usage-page", { harness, page }),
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
  importDesign: (projectId, folderId) => request("import-design", { projectId, folderId }),
  createDesignFolder: (projectId, name) => request("create-design-folder", { projectId, name }),
  renameDesignFolder: (projectId, folderId, name) =>
    request("rename-design-folder", { projectId, folderId, name }),
  readDesign: (projectId, designId) => request("read-design", { projectId, designId }),
  updateDesign: (input) => request("update-design", input),
  uploadDesignAsset: (projectId, dataUrl) => request("upload-design-asset", { projectId, dataUrl }),
  onEvent(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(desktopEventSchema.parse(value));
    ipcRenderer.on("tidy:event", receive);
    return () => ipcRenderer.removeListener("tidy:event", receive);
  },
};

contextBridge.exposeInMainWorld("tidy", api);
