import { contextBridge, ipcRenderer } from "electron";
import {
  projectSnapshotSchema,
  parseWorkspaceResponse,
  type WorkspaceOperation,
  type WorkspaceResponse,
} from "../shared/workspace-response";
import { desktopEventSchema } from "../shared/contracts";
import type { DesktopAPI } from "../shared/contracts";
import { appUpdateStateSchema } from "../shared/app-updates";
import { harnessUpdatesSchema } from "../shared/harness-updates";
import {
  cloudAccountSchema,
  cloudFilesSchema,
  cloudStateSchema,
  cloudCatalogSchema,
  cloudOpenedSchema,
  cloudThumbnailSchema,
  cloudAvatarSchema,
} from "../shared/cloud-sync";

/** Invoke a workspace operation and validate its response before crossing the preload boundary. */
async function request<Name extends WorkspaceOperation>(
  name: Name,
  input?: unknown,
): Promise<WorkspaceResponse<Name>> {
  return parseWorkspaceResponse(name, await ipcRenderer.invoke(`tidy:${name}`, input));
}

const api: DesktopAPI = {
  customTitlebar: process.platform === "darwin",
  onWindowFullscreen(listener) {
    const receive = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen === "boolean") listener(fullscreen);
    };
    ipcRenderer.on("tidy:window-fullscreen", receive);
    return () => ipcRenderer.removeListener("tidy:window-fullscreen", receive);
  },
  /** Validate main-process snapshots before exposing them to the renderer. */
  harnessUpdates: async () =>
    harnessUpdatesSchema.parse(await ipcRenderer.invoke("tidy:harness-updates")),
  /** Request an allowlisted provider update; command construction stays in the main process. */
  installHarnessUpdate: async (id) => {
    await ipcRenderer.invoke("tidy:install-harness-update", id);
  },
  /** Forward only schema-valid broadcasts and release the IPC listener on unsubscribe. */
  onHarnessUpdates(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = harnessUpdatesSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on("tidy:harness-updates", receive);
    return () => {
      ipcRenderer.removeListener("tidy:harness-updates", receive);
    };
  },
  cloud: {
    creatorAvatar: async (file, creator, version) =>
      cloudAvatarSchema.parse(
        await ipcRenderer.invoke("tidy:cloud-creator-avatar", file, creator, version),
      ),
    thumbnail: async (file, version) =>
      cloudThumbnailSchema.parse(await ipcRenderer.invoke("tidy:cloud-thumbnail", file, version)),
    state: async () => cloudStateSchema.parse(await ipcRenderer.invoke("tidy:cloud-state")),
    signIn: async () => {
      await ipcRenderer.invoke("tidy:cloud-sign-in");
    },
    signOut: async () => {
      await ipcRenderer.invoke("tidy:cloud-sign-out");
    },
    account: async (cached) =>
      cloudAccountSchema.parse(await ipcRenderer.invoke("tidy:cloud-account", cached)),
    catalog: async (id, cached) =>
      cloudCatalogSchema.parse(await ipcRenderer.invoke("tidy:cloud-catalog", id, cached)),
    openWorkspace: async (id) =>
      projectSnapshotSchema.parse(await ipcRenderer.invoke("tidy:cloud-open-workspace", id)),
    openFile: async (id, file) =>
      cloudOpenedSchema.parse(await ipcRenderer.invoke("tidy:cloud-open-file", id, file)),
    createFile: async (id) =>
      cloudOpenedSchema.parse(await ipcRenderer.invoke("tidy:cloud-create-file", id)),
    keepBoth: async (organization, project, design) =>
      cloudOpenedSchema.parse(
        await ipcRenderer.invoke("tidy:cloud-keep-both", organization, project, design),
      ),
    focus: async (projectId, designId) => {
      await ipcRenderer.invoke("tidy:cloud-focus", projectId, designId);
    },
    files: async (id) => cloudFilesSchema.parse(await ipcRenderer.invoke("tidy:cloud-files", id)),
    open: async (projectId, fileId, name) => {
      await ipcRenderer.invoke("tidy:cloud-open", projectId, fileId, name);
    },
    disconnect: async (projectId, designId) => {
      await ipcRenderer.invoke("tidy:cloud-disconnect", projectId, designId);
    },
    connectLocal: async (projectId, designId, organizationId) => {
      await ipcRenderer.invoke("tidy:cloud-connect", projectId, designId, organizationId);
    },
    onState(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(cloudStateSchema.parse(value));
      ipcRenderer.on("tidy:cloud-state", receive);
      return () => {
        ipcRenderer.removeListener("tidy:cloud-state", receive);
      };
    },
  },
  updateState: async () =>
    appUpdateStateSchema.parse(await ipcRenderer.invoke("tidy:update-state")),
  checkUpdates: async () => {
    await ipcRenderer.invoke("tidy:check-updates");
  },
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
  skills: (projectId, harness, refresh) => request("skills", { projectId, harness, refresh }),
  harnessDetails: (projectId, harness, refresh) =>
    request("harness-details", { projectId, harness, refresh }),
  openHarnessUsage: (harness, page) => request("harness-usage-page", { harness, page }),
  openChatLink: (projectId, href) => request("open-chat-link", { projectId, href }),
  setThreadSettings: (projectId, threadId, settings) =>
    request("thread-settings", { projectId, threadId, settings }),
  checkHarnesses: () => request("harnesses"),
  repositoryContext: (projectId) => request("repository-context", { projectId }),
  switchBranch: (projectId, branch) => request("switch-branch", { projectId, branch }),
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
  importDesign: (projectId, folderId) => request("import-design", { projectId, folderId }),
  createDesignFolder: (projectId, name) => request("create-design-folder", { projectId, name }),
  renameDesignFolder: (projectId, folderId, name) =>
    request("rename-design-folder", { projectId, folderId, name }),
  readDesign: (projectId, designId) => request("read-design", { projectId, designId }),
  previewDesign: (projectId, designId) => request("preview-design", { projectId, designId }),
  refreshDesign: (projectId, designId, version) =>
    request("refresh-design", { projectId, designId, version }),
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
