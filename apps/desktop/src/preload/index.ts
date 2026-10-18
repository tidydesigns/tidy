import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopEvent } from "../shared/contracts";

async function request<T>(name: string, input?: unknown): Promise<T> {
  const response = (await ipcRenderer.invoke(`tidy:${name}`, input)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

const api: DesktopAPI = {
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
  setThreadDone: (projectId, threadId, done) =>
    request("set-thread-done", { projectId, threadId, done }),
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
    const receive = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on("tidy:event", receive);
    return () => ipcRenderer.removeListener("tidy:event", receive);
  },
};

contextBridge.exposeInMainWorld("tidy", api);
