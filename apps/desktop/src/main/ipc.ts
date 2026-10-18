import { approvalDecisionSchema } from "../shared/permissions";
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readHarnessDetails } from "./harness-details";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import { harnessSettingsSchema } from "../shared/harness-settings";
import { checkHarnesses } from "./harnesses";
import { WorkspaceService } from "./workspace-service";

export function registerWorkspaceIPC(service: WorkspaceService) {
  const store = service.store;
  const uuid = z.string().uuid();
  const projectId = uuid;
  const rendererFile = pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href;

  function authorize(event: IpcMainInvokeEvent) {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Untrusted desktop request.");
    const url = event.senderFrame?.url;
    const devURL = process.env.ELECTRON_RENDERER_URL;
    if (
      url !== rendererFile &&
      !(devURL && new URL(url ?? "about:blank").origin === new URL(devURL).origin)
    )
      throw new Error("Untrusted desktop request.");
  }

  function handle<T extends z.ZodType>(
    name: string,
    schema: T,
    action: (value: z.infer<T>, event: IpcMainInvokeEvent) => unknown,
  ) {
    ipcMain.handle(`tidy:${name}`, async (event, input: unknown) => {
      try {
        authorize(event);
        const parsed = schema.safeParse(input);
        if (!parsed.success) throw new Error("Invalid desktop request.");
        return { ok: true, data: await action(parsed.data, event) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "The operation could not be completed.",
        };
      }
    });
  }

  function liveSnapshot(snapshot: Awaited<ReturnType<typeof store.snapshot>>) {
    return {
      ...snapshot,
      threads: service.withLiveThreads(snapshot.project.id, snapshot.threads),
    };
  }
  handle("bootstrap", z.undefined(), async () => {
    let activeProject = null;
    if (store.activeProjectId) {
      try {
        activeProject = liveSnapshot(await store.snapshot(store.activeProjectId));
        await service.observe(store.activeProjectId);
      } catch {
        /* The recent project may be on an unavailable volume. */
      }
    }
    return { projects: store.projects, activeProject, harnesses: await checkHarnesses() };
  });
  handle("open-project", z.undefined(), async (_value, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)!;
    const result = await dialog.showOpenDialog(window, {
      title: "Open project",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const snapshot = await store.open(result.filePaths[0]);
    await service.observe(snapshot.project.id);
    return liveSnapshot(snapshot);
  });
  handle("select-project", projectId, async (value) => {
    const snapshot = await store.select(value);
    await service.observe(value);
    return liveSnapshot(snapshot);
  });
  handle(
    "harness-details",
    z
      .object({ projectId, harness: z.enum(["codex", "claude"]), refresh: z.boolean().optional() })
      .strict(),
    (value) =>
      readHarnessDetails(value.harness, store.project(value.projectId).path, value.refresh),
  );
  handle(
    "harness-usage-page",
    z
      .object({ harness: z.enum(["codex", "claude"]), page: z.enum(["subscription", "api"]) })
      .strict(),
    (value) =>
      shell.openExternal(
        value.harness === "codex"
          ? value.page === "api"
            ? "https://platform.openai.com/usage"
            : "https://chatgpt.com/codex/settings/usage"
          : value.page === "api"
            ? "https://platform.claude.com/usage"
            : "https://claude.ai/settings/usage",
      ),
  );
  handle(
    "thread-settings",
    z.object({ projectId, threadId: uuid, settings: harnessSettingsSchema }).strict(),
    (value) => service.setThreadSettings(value.projectId, value.threadId, value.settings),
  );
  handle("harnesses", z.undefined(), () => checkHarnesses());
  handle("read-thread", z.object({ projectId, threadId: uuid }).strict(), (value) =>
    service.readThread(value.projectId, value.threadId),
  );
  handle(
    "start-thread",
    z
      .object({
        projectId,
        harness: z.enum(["codex", "claude"]),
        prompt: z.string().trim().max(32_000),
        attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS).optional(),
        designIds: z.array(uuid).max(20),
        settings: harnessSettingsSchema.optional(),
      })
      .strict(),
    (value) => service.startThread(value),
  );
  handle(
    "send-message",
    z
      .object({
        projectId,
        threadId: uuid,
        text: z.string().trim().max(32_000),
        attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS).optional(),
      })
      .strict(),
    (value) => service.sendMessage(value),
  );
  handle(
    "add-attachment",
    z
      .object({
        projectId,
        name: z.string().trim().min(1).max(200),
        dataUrl: z.string().max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 200),
      })
      .strict(),
    (value) => store.addAttachment(value.projectId, value.name, value.dataUrl),
  );
  handle("read-attachment", z.object({ projectId, attachmentId: uuid }).strict(), (value) =>
    store.readAttachment(value.projectId, value.attachmentId),
  );
  handle(
    "set-thread-done",
    z.object({ projectId, threadId: uuid, done: z.boolean() }).strict(),
    (value) => service.setThreadDone(value.projectId, value.threadId, value.done),
  );
  handle(
    "respond-approval",
    z
      .object({ projectId, threadId: uuid, approvalId: uuid, decision: approvalDecisionSchema })
      .strict(),
    (value) =>
      service.respondToApproval(value.projectId, value.threadId, value.approvalId, value.decision),
  );
  handle("stop-thread", z.object({ projectId, threadId: uuid }).strict(), (value) =>
    service.stopThread(value.projectId, value.threadId),
  );
  handle(
    "create-design",
    z.object({ projectId, folderId: uuid.nullable().optional() }).strict(),
    async (value) => {
      const design = await store.createDesign(value.projectId, undefined, value.folderId);
      await service.refreshDesigns(value.projectId);
      return design;
    },
  );
  handle(
    "create-design-folder",
    z.object({ projectId, name: z.string().trim().min(1).max(120) }).strict(),
    async (value) => {
      const folder = await store.createFolder(value.projectId, value.name);
      await service.refreshDesigns(value.projectId);
      return folder;
    },
  );
  handle(
    "rename-design-folder",
    z.object({ projectId, folderId: uuid, name: z.string().trim().min(1).max(120) }).strict(),
    async (value) => {
      const folder = await store.renameFolder(value.projectId, value.folderId, value.name);
      await service.refreshDesigns(value.projectId);
      return folder;
    },
  );
  handle("read-design", z.object({ projectId, designId: uuid }).strict(), (value) =>
    store.readDesign(value.projectId, value.designId),
  );
  handle(
    "update-design",
    z
      .object({
        projectId,
        designId: uuid,
        expectedVersion: z.string().length(64),
        document: z.unknown().optional(),
        name: z.string().trim().min(1).max(120).optional(),
        folderId: uuid.nullable().optional(),
      })
      .strict(),
    (value) => store.updateDesign(value),
  );
  handle(
    "upload-design-asset",
    z.object({ projectId, dataUrl: z.string().max(3_000_000) }).strict(),
    (value) => store.uploadDesignAsset(value.projectId, value.dataUrl),
  );
  handle(
    "import-design",
    z.object({ projectId, folderId: uuid.nullable().optional() }).strict(),
    async (value, event) => {
      store.project(value.projectId);
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
        title: "Import Tidy design",
        properties: ["openFile"],
        filters: [{ name: "Tidy design JSON", extensions: ["json"] }],
      });
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      if ((await stat(file)).size > 16 * 1024 * 1024)
        throw new Error("This design file is too large.");
      const imported: unknown = JSON.parse(await readFile(file, "utf8"));
      const wrapped = z
        .object({ name: z.string().optional(), document: z.unknown() })
        .safeParse(imported);
      const design = await store.createDesign(
        value.projectId,
        {
          name: wrapped.success && wrapped.data.name ? wrapped.data.name : basename(file, ".json"),
          document: wrapped.success ? wrapped.data.document : imported,
        },
        value.folderId,
      );
      await service.refreshDesigns(value.projectId);
      return design;
    },
  );

  return service.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("tidy:event", event);
    }
  });
}
