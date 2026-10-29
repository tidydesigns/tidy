import { DraftImports } from "../workspace/draft-imports";
import { draftImportSchema } from "../../shared/contracts/draft-import";
import { harnessIdSchema } from "../../shared/contracts/desktop";
import {
  branchNameSchema,
  type BranchSwitchResult,
} from "../../shared/contracts/repository-context";
import { readLocalFile } from "../platform/local-files";
import {
  projectDirectories,
  projectRemotes,
  projectRepositoryPath,
  setupProject,
} from "../repository/project-setup";
import { projectSetupSchema } from "../../shared/contracts/project-setup";
import { BranchSwitchError, readRepositoryContext } from "../repository/repository-context";
import { skillIdSchema } from "../../shared/contracts/skills";
import { z } from "zod";
import { approvalDecisionSchema } from "../../shared/contracts/permissions";
import { readHarnessDetails } from "../harnesses/harness-details";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../../shared/contracts/attachments";
import { harnessSettingsSchema } from "../../shared/contracts/harness-settings";
import { HarnessDiscovery } from "../harnesses/harness-discovery";
import { WorkspaceService } from "../workspace/workspace-service";
import { messageDeliverySchema, queueRequestSchema } from "../../shared/contracts/message-queue";
import { chatLinkRequestSchema, openChatLink } from "../workspace/chat-links";

export type WorkspacePlatform<Context> = {
  chooseProject(context: Context): Promise<string | null>;
  chooseDesign(context: Context): Promise<{ name: string; document: unknown } | null>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
};

// Local IPC and remote handlers share the same persisted project selection.
const projectSelections = new WeakMap<WorkspaceService, Promise<unknown>>();

export function createWorkspaceRequests<Context>(
  service: WorkspaceService,
  platform: WorkspacePlatform<Context>,
) {
  const store = service.store;
  const harnessDiscovery = new HarnessDiscovery();
  const imports = new DraftImports(store, (projectId) => service.assertProjectAccess(projectId));
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
      const value = parsed.data;
      const target =
        typeof value === "object" && value !== null && "projectId" in value
          ? value.projectId
          : name === "select-project" || name === "project-snapshot"
            ? value
            : undefined;
      if (typeof target === "string") await service.assertProjectAccess(target);
      const result = await action(value, context);
      if (typeof target === "string") await service.assertProjectAccess(target);
      return result;
    });
  }
  function liveSnapshot(snapshot: Awaited<ReturnType<typeof store.snapshot>>) {
    return {
      ...snapshot,
      threads: service.withLiveThreads(snapshot.project.id, snapshot.threads),
    };
  }
  // A scalar ID keeps this acknowledgement machine-scoped after registration is removed.
  handle("remove-project", uuid, async (id) => {
    await service.removeProject(id);
    return null;
  });
  handle(
    "project-directories",
    z
      .string()
      .max(4096)
      .refine((path) => !path || path.startsWith("/")),
    projectDirectories,
  );
  handle("project-checkouts", uuid.optional(), async (projectId) => {
    const projects = store.projects.filter(
      (project) => !project.cloud && (!projectId || project.id === projectId),
    );
    const result = [];
    for (let start = 0; start < projects.length; start += 4) {
      result.push(
        ...(await Promise.all(
          projects.slice(start, start + 4).map(async (project) => ({
            projectId: project.id,
            remotes: await projectRemotes(project.path),
            repositoryPath: await projectRepositoryPath(project.path),
          })),
        )),
      );
    }
    return result;
  });
  handle("setup-project", projectSetupSchema, async (input) => {
    const result = await setupProject(input);
    if (result.kind !== "ready") return result;
    if (store.projects.some((project) => project.path === result.path && project.cloud))
      throw new Error("Open this cloud workspace through your account instead.");
    const snapshot = await store.open(result.path);
    await service.assertProjectAccess(snapshot.project.id);
    await imports.recover(snapshot.project.id);
    await service.observe(snapshot.project.id);
    return {
      kind: "ready",
      snapshot: liveSnapshot(await store.snapshot(snapshot.project.id)),
    } as const;
  });
  handle(
    "export-attachment",
    z.object({ projectId, attachmentId: uuid }).strict(),
    async (input) => {
      const file = await store.resolveAttachment(input.projectId, input.attachmentId);
      return {
        name: file.name,
        dataUrl: `data:${file.mimeType};base64,${(await readLocalFile(file.path, MAX_ATTACHMENT_BYTES)).toString("base64")}`,
      };
    },
  );
  handle("export-design", z.object({ projectId, designId: uuid }).strict(), async (input) => {
    const design = await store.readDesign(input.projectId, input.designId);
    const assets: Record<string, string> = {};
    let size = Buffer.byteLength(JSON.stringify(design.document));
    if (size > 28_000_000)
      throw new Error("This design is too large to transfer. Choose a smaller reference.");
    for (const id of Object.keys(design.assets)) {
      const value = await store.readSyncAsset(input.projectId, id);
      if (!value || !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value))
        throw new Error(
          "A design image is unavailable. Open the design on its machine and try again.",
        );
      size += Buffer.byteLength(value);
      if (size > 28_000_000)
        throw new Error("This design is too large to transfer. Choose a smaller reference.");
      assets[id] = value;
    }
    return { ...design, assets };
  });
  handle("import-draft", draftImportSchema, (input) => imports.import(input));
  handle("bootstrap", z.undefined(), async () => {
    const harnesses = harnessDiscovery.snapshot();
    let activeProject = null;
    if (
      store.activeProjectId &&
      store.projects.some((project) => project.id === store.activeProjectId && !project.cloud)
    ) {
      try {
        await imports.recover(store.activeProjectId);
        activeProject = liveSnapshot(await store.snapshot(store.activeProjectId));
        await service.observe(store.activeProjectId);
      } catch {
        /* The recent project may be on an unavailable volume. */
      }
    }
    return {
      projects: store.projects.filter((project) => !project.cloud),
      activeProject,
      harnesses,
    };
  });
  handle("open-project", z.undefined(), async (_value, event) => {
    const path = await platform.chooseProject(event);
    if (!path) return null;
    const snapshot = await store.open(path);
    await imports.recover(snapshot.project.id);
    await service.observe(snapshot.project.id);
    return liveSnapshot(await store.snapshot(snapshot.project.id));
  });
  handle("project-snapshot", projectId, async (value) => liveSnapshot(await store.snapshot(value)));
  handle("select-project", projectId, async (value) => {
    await imports.recover(value);
    const snapshot = await store.select(value);
    await service.observe(value);
    return liveSnapshot(snapshot);
  });
  handle(
    "skills",
    z.object({ projectId, harness: harnessIdSchema, refresh: z.boolean().optional() }).strict(),
    (value) =>
      service.skills.list({
        harness: value.harness,
        cwd: store.project(value.projectId).path,
        refresh: value.refresh,
      }),
  );
  handle(
    "harness-details",
    z.object({ projectId, harness: harnessIdSchema, refresh: z.boolean().optional() }).strict(),
    (value) =>
      readHarnessDetails(value.harness, store.project(value.projectId).path, value.refresh),
  );
  handle(
    "harness-usage-page",
    z.object({ harness: harnessIdSchema, page: z.enum(["subscription", "api"]) }).strict(),
    (value) =>
      platform.openExternal(
        value.harness === "opencode"
          ? "https://opencode.ai/auth"
          : value.harness === "codex"
            ? value.page === "api"
              ? "https://platform.openai.com/usage"
              : "https://chatgpt.com/codex/settings/usage"
            : value.page === "api"
              ? "https://platform.claude.com/usage"
              : "https://claude.ai/settings/usage",
      ),
  );
  handle("open-chat-link", chatLinkRequestSchema, (value) =>
    openChatLink({ root: store.project(value.projectId).path, href: value.href, platform }),
  );
  handle(
    "thread-settings",
    z.object({ projectId, threadId: uuid, settings: harnessSettingsSchema }).strict(),
    (value) => service.setThreadSettings(value.projectId, value.threadId, value.settings),
  );
  handle("repository-context", z.object({ projectId }).strict(), (value) =>
    readRepositoryContext(store.project(value.projectId).path),
  );
  handle(
    "switch-branch",
    z.object({ projectId, branch: branchNameSchema }).strict(),
    async (value): Promise<BranchSwitchResult> => {
      try {
        return {
          kind: "switched",
          context: await service.switchBranch(value.projectId, value.branch),
        };
      } catch (error) {
        if (error instanceof BranchSwitchError) return { kind: "blocked", reason: error.reason };
        throw error;
      }
    },
  );
  handle("harnesses", z.undefined(), () => harnessDiscovery.refresh());
  handle("read-thread", z.object({ projectId, threadId: uuid }).strict(), (value) =>
    service.readThread(value.projectId, value.threadId),
  );
  handle(
    "warm-thread",
    z
      .object({
        projectId,
        threadId: uuid.optional(),
        executionProjectId: uuid.optional(),
        harness: harnessIdSchema,
        settings: harnessSettingsSchema.optional(),
      })
      .strict(),
    (value) => service.warmThread(value),
  );
  handle(
    "start-thread",
    z
      .object({
        projectId,
        executionProjectId: uuid.optional(),
        threadId: uuid.optional(),
        messageId: uuid.optional(),
        harness: harnessIdSchema,
        prompt: z.string().trim().max(32_000),
        attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS).optional(),
        skillId: skillIdSchema.optional(),
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
        delivery: messageDeliverySchema.optional(),
        projectId,
        threadId: uuid,
        messageId: uuid.optional(),
        text: z.string().trim().max(32_000),
        attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS).optional(),
        skillId: skillIdSchema.optional(),
      })
      .strict(),
    (value) => service.sendMessage(value),
  );
  handle("message-queue", queueRequestSchema, (value) => service.updateMessageQueue(value));
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
  handle("preview-design", z.object({ projectId, designId: uuid }).strict(), (value) =>
    store.readDesign(value.projectId, value.designId, true, true),
  );
  handle(
    "refresh-design",
    z.object({ projectId, designId: uuid, version: z.string().length(64) }).strict(),
    (value) => store.readDesignIfChanged(value.projectId, value.designId, value.version),
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
      if (name === "select-project") {
        const previous = projectSelections.get(service) ?? Promise.resolve();
        const request = service.dispatch(() => previous.then(() => action(input, context)));
        // A failed selection must release the next one, including its access checks.
        projectSelections.set(
          service,
          request.catch(() => {}),
        );
        return request;
      }
      return service.dispatch(() => action(input, context));
    },
  };
}
