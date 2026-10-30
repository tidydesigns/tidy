import {
  browserDiscardDraftSchema,
  browserOutputEnvelopeSchema,
  isBrowserQuery,
  browserCommandSchema,
  browserInputEnvelopeSchema,
  browserScopeSchema,
  type BrowserAPI,
} from "../shared/contracts/browser";
import {
  connectionStatusSchema,
  machineSchema,
  sshHostSchema,
  type RemoteBridge,
} from "../shared/remote";
import { directoryResponseSchema } from "../shared/contracts/browser-directory";
import {
  workspaceMachineSchema,
  machineIdSchema,
  type MachineBridge,
  tailnetDiscoverySchema,
} from "../shared/remote";
import { contextBridge, ipcRenderer } from "electron";
import { analyticsStateSchema } from "@tidy/design/analytics";
import {
  projectSnapshotSchema,
  parseWorkspaceResponse,
  type WorkspaceOperation,
  type WorkspaceResponse,
} from "../shared/contracts/workspace-response";
import { desktopEventSchema } from "../shared/contracts/desktop";
import type { DesktopAPI } from "../shared/contracts/desktop";
import { appUpdateStateSchema } from "../shared/contracts/app-updates";
import { harnessUpdatesSchema } from "../shared/contracts/harness-updates";
import {
  cloudAccountSchema,
  cloudFilesSchema,
  cloudStateSchema,
  cloudCatalogSchema,
  cloudOpenedSchema,
  cloudThumbnailSchema,
  cloudAvatarSchema,
} from "../shared/contracts/cloud-sync";

/** Invoke a workspace operation and validate its response before crossing the preload boundary. */
async function request<Name extends WorkspaceOperation>(
  name: Name,
  input?: unknown,
  machineId?: string,
): Promise<WorkspaceResponse<Name>> {
  return parseWorkspaceResponse(
    name,
    await ipcRenderer.invoke("tidy:workspace", { machineId, name, input }),
  );
}

function browserApi(machineId?: string): BrowserAPI {
  const watches = new Map<string, string>();
  const keyFor = (scope: { projectId: string; threadId: string }) =>
    `${scope.projectId}:${scope.threadId}`;
  return {
    discardDraft: (input) =>
      request("browser-discard-draft", browserDiscardDraftSchema.parse(input), machineId),
    download: async (name, data) => {
      await ipcRenderer.invoke("tidy:browser-download", { name, data });
    },
    copy: async (text) => {
      await ipcRenderer.invoke("tidy:browser-copy", text);
    },
    command: (raw) => {
      const command = browserCommandSchema.parse(raw);
      return request(
        isBrowserQuery(command.action) ? "browser-query" : "browser-command",
        { ...command, viewerId: watches.get(keyFor(command)) },
        machineId,
      );
    },
    watch: (raw, receive) => {
      const scope = browserScopeSchema.parse(raw);
      const watchId = crypto.randomUUID();
      const key = keyFor(scope);
      watches.set(key, watchId);
      let closed = false;
      const listener = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        if (closed) return;
        const parsed = browserOutputEnvelopeSchema.safeParse(raw);
        if (parsed.success && parsed.data.watchId === watchId) receive(parsed.data.output);
      };
      ipcRenderer.on("tidy:browser-output", listener);
      void ipcRenderer
        .invoke("tidy:browser-watch", { ...scope, watchId, machineId })
        .catch((error: unknown) => {
          if (!closed)
            receive({
              kind: "error",
              message: error instanceof Error ? error.message : "Browser unavailable.",
            });
        });
      return () => {
        closed = true;
        if (watches.get(key) === watchId) watches.delete(key);
        ipcRenderer.removeListener("tidy:browser-output", listener);
        ipcRenderer.send("tidy:browser-unwatch", watchId);
      };
    },
    input: (scope, raw) => {
      const watchId = watches.get(keyFor(scope));
      if (watchId)
        ipcRenderer.send("tidy:browser-input", {
          watchId,
          input: browserInputEnvelopeSchema.parse(raw),
        });
    },
  };
}

function workspaceApi(machineId?: string): DesktopAPI {
  const scopedRequest = <Name extends WorkspaceOperation>(name: Name, input?: unknown) =>
    request(name, input, machineId);
  return {
    browser: browserApi(machineId),
    projectDirectories: (path) => scopedRequest("project-directories", path),
    projectCheckouts: (projectId) => scopedRequest("project-checkouts", projectId),
    setupProject: (input) => scopedRequest("setup-project", input),
    exportAttachment: (projectId, attachmentId) =>
      scopedRequest("export-attachment", { projectId, attachmentId }),
    exportDesign: (projectId, designId) => scopedRequest("export-design", { projectId, designId }),
    importDraft: (input) => scopedRequest("import-draft", input),
    reloadApp: async () => {
      await ipcRenderer.invoke("tidy:reload-app");
    },
    analytics: {
      subscribe(listener) {
        const receive = (_event: Electron.IpcRendererEvent, state: unknown) => {
          const value = analyticsStateSchema.safeParse(state);
          if (value.success) listener(value.data);
        };
        ipcRenderer.on("tidy:privacy-state", receive);
        return () => {
          ipcRenderer.removeListener("tidy:privacy-state", receive);
        };
      },
      reportError: async () => {
        await ipcRenderer.invoke("tidy:analytics", "renderer-error");
      },
      performance: async (duration) => {
        await ipcRenderer.invoke("tidy:analytics", "performance", duration);
      },
      state: async () =>
        analyticsStateSchema.parse(await ipcRenderer.invoke("tidy:analytics", "state")),
      choose: async (choices) =>
        analyticsStateSchema.parse(await ipcRenderer.invoke("tidy:analytics", "choose", choices)),
      link: async () => {
        await ipcRenderer.invoke("tidy:analytics", "link");
      },
      unlink: async () =>
        analyticsStateSchema.parse(await ipcRenderer.invoke("tidy:analytics", "unlink")),
      erase: async () =>
        analyticsStateSchema.parse(await ipcRenderer.invoke("tidy:analytics", "erase")),
      reports: async () => String(await ipcRenderer.invoke("tidy:analytics", "reports")),
      policy: async () => {
        await ipcRenderer.invoke("tidy:analytics", "policy");
      },
    },
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
    projectSnapshot: (id) => scopedRequest("project-snapshot", id),
    bootstrap: () => scopedRequest("bootstrap"),
    openProject: () => scopedRequest("open-project"),
    selectProject: (projectId) => scopedRequest("select-project", projectId),
    removeProject: async (projectId) => {
      await scopedRequest("remove-project", projectId);
    },
    skills: (projectId, harness, refresh) =>
      scopedRequest("skills", { projectId, harness, refresh }),
    harnessDetails: (projectId, harness, refresh) =>
      scopedRequest("harness-details", { projectId, harness, refresh }),
    openHarnessUsage: (harness, page) => scopedRequest("harness-usage-page", { harness, page }),
    readVideoChunk: (input) => scopedRequest("read-video-chunk", input),
    openChatLink: (projectId, href) => scopedRequest("open-chat-link", { projectId, href }),
    setThreadSettings: (projectId, threadId, settings) =>
      scopedRequest("thread-settings", { projectId, threadId, settings }),
    checkHarnesses: () => scopedRequest("harnesses"),
    repositoryContext: (projectId) => scopedRequest("repository-context", { projectId }),
    switchBranch: (projectId, branch) => scopedRequest("switch-branch", { projectId, branch }),
    readThread: (projectId, threadId) => scopedRequest("read-thread", { projectId, threadId }),
    warmThread: (input) => scopedRequest("warm-thread", input),
    startThread: (input) => scopedRequest("start-thread", input),
    sendMessage: (input) => scopedRequest("send-message", input),
    updateMessageQueue: (input) => scopedRequest("message-queue", input),
    addAttachment: (projectId, name, dataUrl) =>
      scopedRequest("add-attachment", { projectId, name, dataUrl }),
    readAttachment: (projectId, attachmentId) =>
      scopedRequest("read-attachment", { projectId, attachmentId }),
    setThreadDone: (projectId, threadId, done) =>
      scopedRequest("set-thread-done", { projectId, threadId, done }),
    respondToApproval: (projectId, threadId, approvalId, decision) =>
      scopedRequest("respond-approval", { projectId, threadId, approvalId, decision }),
    stopThread: (projectId, threadId) => scopedRequest("stop-thread", { projectId, threadId }),
    createDesign: (projectId, folderId) => scopedRequest("create-design", { projectId, folderId }),
    importDesign: (projectId, folderId) => scopedRequest("import-design", { projectId, folderId }),
    createDesignFolder: (projectId, name) =>
      scopedRequest("create-design-folder", { projectId, name }),
    renameDesignFolder: (projectId, folderId, name) =>
      scopedRequest("rename-design-folder", { projectId, folderId, name }),
    readDesign: (projectId, designId) => scopedRequest("read-design", { projectId, designId }),
    previewDesign: (projectId, designId) =>
      scopedRequest("preview-design", { projectId, designId }),
    refreshDesign: (projectId, designId, version) =>
      scopedRequest("refresh-design", { projectId, designId, version }),
    updateDesign: (input) => scopedRequest("update-design", input),
    uploadDesignAsset: (projectId, dataUrl) =>
      scopedRequest("upload-design-asset", { projectId, dataUrl }),
    onEvent(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(desktopEventSchema.parse(value));
      if (!machineId || machineId === "local") {
        ipcRenderer.on("tidy:event", receive);
        return () => ipcRenderer.removeListener("tidy:event", receive);
      }
      const scoped = (_event: Electron.IpcRendererEvent, id: string, value: unknown) => {
        if (id === machineId) receive(_event, value);
      };
      ipcRenderer.on("tidy:machine-event", scoped);
      return () => ipcRenderer.removeListener("tidy:machine-event", scoped);
    },
  };
}
contextBridge.exposeInMainWorld("tidy", workspaceApi());

function remoteBridge(machineId?: string): RemoteBridge {
  return {
    connect: (target) => ipcRenderer.invoke("tidy:remote-connect", target),
    machines: async () =>
      machineSchema.array().parse(await ipcRenderer.invoke("tidy:remote-machines")),
    tailnet: async () =>
      tailnetDiscoverySchema.parse(await ipcRenderer.invoke("tidy:remote-tailnet")),
    discover: async () =>
      sshHostSchema.array().parse(await ipcRenderer.invoke("tidy:remote-discover")),
    forget: (id) => ipcRenderer.invoke("tidy:remote-forget", id),
    retry: () => ipcRenderer.invoke("tidy:remote-retry", machineId),
    verify: (id) => ipcRenderer.invoke("tidy:remote-verify", id, machineId),
    cancelVerification: (id) =>
      ipcRenderer.invoke("tidy:remote-cancel-verification", id, machineId),
    activity: (input) => ipcRenderer.invoke("tidy:remote-activity", input, machineId),
    authenticate: (input) => ipcRenderer.invoke("tidy:remote-authenticate", input, machineId),
    status: async () =>
      connectionStatusSchema
        .nullable()
        .parse(await ipcRenderer.invoke("tidy:remote-status", machineId)),
    onStatus(listener) {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(connectionStatusSchema.parse(value));
      if (!machineId) {
        ipcRenderer.on("tidy:remote-status", receive);
        return () => ipcRenderer.removeListener("tidy:remote-status", receive);
      }
      const scoped = (_event: Electron.IpcRendererEvent, id: string, value: unknown) => {
        if (id === machineId) receive(_event, value);
      };
      ipcRenderer.on("tidy:machine-status", scoped);
      return () => ipcRenderer.removeListener("tidy:machine-status", scoped);
    },
    directories: async (path) => {
      const result = directoryResponseSchema.parse(
        await ipcRenderer.invoke("tidy:remote-directories", path, machineId),
      );
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    openProject: async (path) => {
      const result = parseWorkspaceResponse(
        "open-project",
        await ipcRenderer.invoke("tidy:remote-open-project", path, machineId),
      );
      if (!result) throw new Error("Remote project did not open.");
      return result;
    },
  };
}
contextBridge.exposeInMainWorld("tidyRemote", remoteBridge());
const machines: MachineBridge = {
  list: async () =>
    workspaceMachineSchema
      .array()
      .nullable()
      .parse(await ipcRenderer.invoke("tidy:machine-list")),
  onChanged(listener) {
    const receive = () => listener();
    ipcRenderer.on("tidy:machines-changed", receive);
    return () => ipcRenderer.removeListener("tidy:machines-changed", receive);
  },
  workspace(id) {
    const machineId = machineIdSchema.parse(id);
    return { api: workspaceApi(machineId), remote: remoteBridge(machineId) };
  },
};
contextBridge.exposeInMainWorld("tidyMachines", machines);

type ConnectivityWindow = {
  addEventListener(name: string, listener: () => void): void;
  navigator: {
    onLine: boolean;
    connection?: { type?: string; addEventListener(name: string, listener: () => void): void };
  };
};
declare const window: ConnectivityWindow;
const reportNetwork = () =>
  ipcRenderer.send("tidy:connectivity", {
    kind: "network",
    online: window.navigator.onLine,
  });
window.addEventListener("online", reportNetwork);
window.addEventListener("offline", reportNetwork);
const connection = window.navigator.connection;
let connectionType = connection?.type;
connection?.addEventListener("change", () => {
  const next = connection.type;
  if (next && connectionType && next !== connectionType)
    ipcRenderer.send("tidy:connectivity", { kind: "network-changed" });
  connectionType = next;
});
