import { parseDesignDocument } from "@tidy/design/document";
import type { AttachedFile } from "../shared/contracts/attachments";
import type {
  DesktopAPI,
  DesktopEvent,
  DesignFolder,
  LocalDesign,
  ProjectSnapshot,
  Thread,
} from "../shared/contracts/desktop";
import { summarizeThread } from "../shared/models/thread-updates";
import { demoId, project, sampleDesign, sampleThreads } from "./fixture";

/** Browser-only, in-memory host. No Electron IPC, model calls or filesystem gateway. */
export function createDemoAPI(): DesktopAPI {
  const designs = new Map([[demoId(2), sampleDesign()]]);
  const threads = new Map(sampleThreads().map((t) => [t.id, t]));
  const folders = new Map<string, DesignFolder>();
  const attachments = new Map<string, AttachedFile>();
  const listeners = new Set<(event: DesktopEvent) => void>();
  const clone = <T>(value: T): T => structuredClone(value);
  const harnesses = [
    { id: "claude", name: "Claude Code", status: "ready" },
    { id: "codex", name: "Codex", status: "ready" },
  ] as const;
  const getDesign = (id: string) => {
    const v = designs.get(id);
    if (!v) throw Error("Design not found in this demo.");
    return v;
  };
  const getThread = (id: string) => {
    const v = threads.get(id);
    if (!v) throw Error("Thread not found in this demo.");
    return v;
  };
  const summaries = () =>
    [...designs.values()].map((value) => ({
      id: value.id,
      name: value.name,
      path: value.path,
      folderId: value.folderId,
      updatedAt: value.updatedAt,
      nodeCount: value.nodeCount,
    }));
  const snapshot = (): ProjectSnapshot =>
    clone({
      project,
      designs: summaries(),
      folders: [...folders.values()],
      threads: [...threads.values()].map(summarizeThread),
    });
  const emit = (event: DesktopEvent) => {
    for (const listener of listeners) listener(clone(event));
  };
  const designEvent = () =>
    emit({
      type: "designs",
      projectId: project.id,
      designs: summaries(),
      folders: [...folders.values()],
    });
  const updateThread = (value: Thread) => {
    const next = { ...value, revision: value.revision + 1, updatedAt: new Date().toISOString() };
    threads.set(next.id, next);
    emit({ type: "thread", thread: next });
    return clone(next);
  };
  const checkProject = (id: string) => {
    if (id !== project.id) throw Error("Only the sample project is available in this demo.");
  };
  const unsupported = async () => {
    throw Error("Open Tidy to use this action with your own project.");
  };
  let branch = "main";
  return {
    threadPorts: async () => [],
    setThreadExecutionProject: unsupported,
    stopThreadPort: unsupported,
    customTitlebar: true,
    readVideoChunk: unsupported,
    renameThread: unsupported,
    regenerateThreadTitle: unsupported,
    bootstrap: async () => ({
      projects: [clone(project)],
      activeProject: snapshot(),
      harnesses: clone([...harnesses]),
    }),
    openProject: async () => snapshot(),
    selectProject: async (id) => {
      checkProject(id);
      return snapshot();
    },
    checkHarnesses: async () => clone([...harnesses]),
    repositoryContext: async () => ({
      machine: "Demo workspace",
      repository: true,
      branch,
      branches: ["main", "feat/landing-page"],
    }),
    switchBranch: async (_, value) => {
      branch = value;
      return {
        kind: "switched",
        context: {
          machine: "Demo workspace",
          repository: true,
          branch,
          branches: ["main", "feat/landing-page"],
        },
      };
    },
    skills: async () => ({ skills: [] }),
    harnessDetails: async (_, harness) => ({
      models: [
        {
          id: harness === "claude" ? "claude-sonnet" : "gpt-5",
          name: harness === "claude" ? "Sonnet" : "GPT-5",
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
      ],
      defaultModel: harness === "claude" ? "claude-sonnet" : "gpt-5",
      defaultEffort: "medium",
      windows: [],
      usagePage: "subscription",
      updatedAt: new Date().toISOString(),
    }),
    openHarnessUsage: unsupported,
    readChatImage: async () => {
      throw new Error("Image unavailable in this demo.");
    },
    openChatLink: async (_, href) => {
      const url = new URL(href, location.origin);
      if (url.protocol !== "https:") throw Error("External files are unavailable in the demo.");
      window.open(url.href, "_blank", "noopener,noreferrer");
    },
    harnessUpdates: async () => [],
    installHarnessUpdate: unsupported,
    onHarnessUpdates: () => () => {},
    updateState: async () => ({ status: "unsupported" }),
    checkUpdates: async () => {},
    installUpdate: unsupported,
    onUpdate: () => () => {},
    readThread: async (id, threadId) => {
      checkProject(id);
      return clone(getThread(threadId));
    },
    setThreadSettings: async (_, id, settings) => updateThread({ ...getThread(id), settings }),
    startThread: async (input) => {
      checkProject(input.projectId);
      return updateThread({
        id: input.threadId ?? crypto.randomUUID(),
        projectId: project.id,
        revision: 0,
        title: input.prompt.slice(0, 80),
        harness: input.harness,
        settings: input.settings,
        designIds: input.designIds.length ? input.designIds : [demoId(2)],
        messages: [
          { id: input.messageId ?? crypto.randomUUID(), role: "user", text: input.prompt },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: "This is a local demo conversation. Open the floating design preview to explore the real canvas, or switch between the sample threads. Open Tidy to connect your own coding agent.",
          },
        ],
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
    },
    sendMessage: async (input) => {
      const t = getThread(input.threadId);
      return updateThread({
        ...t,
        messages: [
          ...t.messages,
          { id: input.messageId ?? crypto.randomUUID(), role: "user", text: input.text },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: "Your message stays in this demo. The sample design is fully editable: click its floating preview to open the canvas, then minimise it to return to the conversation.",
          },
        ],
        status: "completed",
      });
    },
    stopThread: async (_, id) => {
      updateThread({ ...getThread(id), status: "stopped" });
    },
    setThreadDone: async (_, id, done) =>
      updateThread({ ...getThread(id), doneAt: done ? new Date().toISOString() : undefined }),
    respondToApproval: unsupported,
    updateMessageQueue: unsupported,
    addAttachment: async (_, name, dataUrl) => {
      if (dataUrl.length > 7_000_000) throw Error("Choose a smaller file for the demo.");
      const file = {
        id: crypto.randomUUID(),
        name,
        mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] ?? "application/octet-stream",
        size: Math.floor(dataUrl.length * 0.75),
        previewUrl: dataUrl,
      };
      attachments.set(file.id, file);
      return clone(file);
    },
    readAttachment: async (_, id) => {
      const file = attachments.get(id);
      if (!file) throw Error("Attachment not found.");
      return clone(file);
    },
    readDesign: async (id, designId) => {
      checkProject(id);
      return clone(getDesign(designId));
    },
    previewDesign: async (id, designId) => {
      checkProject(id);
      return clone(getDesign(designId));
    },
    refreshDesign: async (_, id, version) => {
      const value = getDesign(id);
      return value.version === version ? null : clone(value);
    },
    updateDesign: async (input) => {
      checkProject(input.projectId);
      const value = getDesign(input.designId);
      if (input.expectedVersion !== value.version)
        throw Error("The design changed. Please try again.");
      const next: LocalDesign = {
        ...value,
        document: input.document ? parseDesignDocument(input.document) : value.document,
        name: input.name ?? value.name,
        folderId: input.folderId === undefined ? value.folderId : input.folderId,
        version: String(Number(value.version) + 1),
        updatedAt: new Date().toISOString(),
      };
      next.nodeCount = next.document.nodes.length;
      designs.set(next.id, next);
      designEvent();
      return clone(next);
    },
    createDesign: async (id, folderId) => {
      checkProject(id);
      const design = {
        ...sampleDesign(),
        id: crypto.randomUUID(),
        name: "Untitled",
        nodeCount: 0,
        folderId: folderId ?? null,
        document: parseDesignDocument({
          schemaVersion: 1,
          pages: [{ id: "page-1", name: "Page 1" }],
          nodes: [],
          warnings: [],
        }),
      };
      design.path = `.tidy/designs/${design.id}.json`;
      designs.set(design.id, design);
      designEvent();
      return clone(design);
    },
    importDesign: unsupported,
    createDesignFolder: async (_, name) => {
      const folder = { id: crypto.randomUUID(), name, updatedAt: new Date().toISOString() };
      folders.set(folder.id, folder);
      designEvent();
      return clone(folder);
    },
    renameDesignFolder: async (_, id, name) => {
      const folder = folders.get(id);
      if (!folder) throw Error("Folder not found.");
      const next = { ...folder, name, updatedAt: new Date().toISOString() };
      folders.set(id, next);
      designEvent();
      return clone(next);
    },
    uploadDesignAsset: async (_, dataUrl) => {
      if (
        !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(dataUrl) ||
        dataUrl.length > 7_000_000
      )
        throw Error("Choose an image smaller than 5 MB.");
      const assetId = crypto.randomUUID();
      for (const design of designs.values()) design.assets[assetId] = dataUrl;
      return { assetId, url: dataUrl };
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function prepareDemo() {
  const api = createDemoAPI();
  Object.assign(window, { tidy: api });
  // Embedded browsers may disable storage; retain the app’s default navigation in that case.
  try {
    const first = demoId(10);
    for (const [key, value] of Object.entries({
      workspace: { kind: "local" },
      project: project.id,
      mode: "code",
      threads: { [project.id]: first },
      designs: {},
      settings: false,
    })) {
      sessionStorage.setItem(`tidy:navigation:${key}`, JSON.stringify(value));
    }
    for (const thread of sampleThreads())
      localStorage.setItem(
        `tidy:canvas-dock:${project.id}:${thread.id}`,
        JSON.stringify({
          ids: [demoId(2)],
          openIds: [demoId(2)],
          // Stage the product capture below the conversation using the app's
          // persisted window geometry. The interactive demo keeps native defaults.
          ...(new URLSearchParams(location.search).get("view") === "desktop"
            ? {
                geometry: {
                  [demoId(2)]: {
                    x: Math.max(16, innerWidth - 264 - 332),
                    y: Math.max(16, innerHeight - 430),
                    width: 296,
                    height: 197,
                  },
                },
              }
            : {}),
        }),
      );
  } catch {
    /* Storage unavailable. */
  }
  return api;
}
