import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { checkHarnesses } from "./harnesses";
import { WorkspaceService } from "./workspace-service";

export function registerWorkspaceIPC(service: WorkspaceService) {
  const store = service.store;
  const uuid = z.string().uuid();
  const projectId = uuid;
  const prompt = z.string().trim().min(1).max(32_000);
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

  handle("bootstrap", z.undefined(), async () => {
    let activeProject = null;
    if (store.activeProjectId) {
      try {
        activeProject = await store.snapshot(store.activeProjectId);
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
    return snapshot;
  });
  handle("select-project", projectId, async (value) => {
    const snapshot = await store.select(value);
    await service.observe(value);
    return snapshot;
  });
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
        prompt,
        designIds: z.array(uuid).max(20),
      })
      .strict(),
    (value) => service.startThread(value),
  );
  handle("send-message", z.object({ projectId, threadId: uuid, text: prompt }).strict(), (value) =>
    service.sendMessage(value),
  );
  handle("stop-thread", z.object({ projectId, threadId: uuid }).strict(), (value) =>
    service.stopThread(value.projectId, value.threadId),
  );
  handle("create-design", projectId, async (value) => {
    const design = await store.createDesign(value);
    await service.refreshDesigns(value);
    return design;
  });
  handle("read-design", z.object({ projectId, designId: uuid }).strict(), (value) =>
    store.readDesign(value.projectId, value.designId),
  );
  handle("import-design", projectId, async (value, event) => {
    store.project(value);
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
    const design = await store.createDesign(value, {
      name: wrapped.success && wrapped.data.name ? wrapped.data.name : basename(file, ".json"),
      document: wrapped.success ? wrapped.data.document : imported,
    });
    await service.refreshDesigns(value);
    return design;
  });

  return service.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("tidy:event", event);
    }
  });
}
