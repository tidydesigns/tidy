import { z } from "zod";
import { approvalDecisionSchema } from "../shared/permissions";
import { readHarnessDetails } from "./harness-details";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import { harnessSettingsSchema } from "../shared/harness-settings";
import { checkHarnesses } from "./harnesses";
import { WorkspaceService } from "./workspace-service";

export type WorkspacePlatform<Context> = {
  chooseProject(context: Context): Promise<string | null>;
  chooseDesign(context: Context): Promise<{ name: string; document: unknown } | null>;
  openExternal(url: string): Promise<void>;
};

/** The same validated operations serve native IPC and the development browser. */
export function createWorkspaceRequests<Context>(
  service: WorkspaceService,
  platform: WorkspacePlatform<Context>,
) {
  const store = service.store;
  const uuid = z.string().uuid();
  const projectId = uuid;
  const handlers = new Map<string, (input: unknown, context: Context) => Promise<unknown>>();
  function handle<T extends z.ZodType>(
    name: string,
    schema: T,
    action: (value: z.infer<T>, context: Context) => unknown,
  ) {
    handlers.set(name, async (input, context) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid desktop request.");
      return action(parsed.data, context);
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
    const path = await platform.chooseProject(event);
    if (!path) return null;
    const snapshot = await store.open(path);
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
      platform.openExternal(
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
        threadId: uuid.optional(),
        messageId: uuid.optional(),
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
        messageId: uuid.optional(),
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
      const file = await platform.chooseDesign(event);
      if (!file) return null;
      const imported = file.document;
      const wrapped = z
        .object({ name: z.string().optional(), document: z.unknown() })
        .safeParse(imported);
      const design = await store.createDesign(
        value.projectId,
        {
          name: wrapped.success && wrapped.data.name ? wrapped.data.name : file.name,
          document: wrapped.success ? wrapped.data.document : imported,
        },
        value.folderId,
      );
      await service.refreshDesigns(value.projectId);
      return design;
    },
  );

  return {
    names: [...handlers.keys()],
    async invoke(name: string, input: unknown, context: Context) {
      const action = handlers.get(name);
      if (!action) throw new Error("Unknown desktop request.");
      return action(input, context);
    },
  };
}
