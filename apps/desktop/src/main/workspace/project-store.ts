import { randomUUID } from "node:crypto";
import { PrivateState } from "../platform/private-state";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { blankDesignDocument, parseDesignDocument, documentAssetIds } from "@tidy/design/document";
import { z } from "zod";
import {
  attachmentSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  type AttachedFile,
} from "../../shared/contracts/attachments";
import type {
  DesignFolder,
  LocalDesign,
  Project,
  ProjectSnapshot,
  Thread,
  ThreadSummary,
} from "../../shared/contracts/desktop";
import { summarizeThread } from "../../shared/models/thread-updates";
import { ThreadAuthority } from "./thread-authority";
import { toolLogSize } from "../../shared/contracts/tool-activity";
import { readLocalFile } from "../platform/local-files";
import { CloudCompute } from "../cloud/cloud-compute";
import {
  designFileStamp,
  summarizeDesignFile,
  type ParsedDesignFile,
  type DesignFileSummary,
} from "./design-file";

const projectCompute = new CloudCompute();

import { storedThreadSchema as threadSchema } from "../../shared/contracts/desktop";

const id = z.string().uuid();
const registrySchema = z.object({
  version: z.literal(1),
  activeProjectId: z.string().nullable(),
  projects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
        openedAt: z.string(),
        cloud: z.boolean().optional(),
      }),
    )
    .max(100),
});

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
/** Project directories are explicitly selected on the host, then addressed by IDs. */
export class ProjectStore {
  readonly processState: PrivateState;
  analytics?: (event: import("@tidy/design/analytics").AnalyticsEvent) => void;
  private registry: z.infer<typeof registrySchema> = {
    version: 1,
    activeProjectId: null,
    projects: [],
  };
  private writes = Promise.resolve();
  private designCache = new Map<string, ParsedDesignFile>();
  private summaryCache = new Map<string, DesignFileSummary>();
  private designReads = new Map<string, Promise<ParsedDesignFile>>();
  private summaryReads = new Map<string, Promise<DesignFileSummary>>();
  private threadSummaryCache = new Map<string, { stamp: string; summary: ThreadSummary }>();

  private storageClaims = new Map<
    string,
    { release(): void; pending: number; retained: boolean }
  >();
  private authority: ThreadAuthority;
  constructor(
    private directory: string,
    private assetBase = "/__tidy/assets",
    private claimProject: (path: string) => () => void = () => () => {},
  ) {
    this.authority = new ThreadAuthority(join(directory, "thread-authority"));
    this.processState = new PrivateState(join(directory, "process-state"));
  }

  private storageClaim(path: string) {
    let claim = this.storageClaims.get(path);
    if (!claim) {
      claim = { release: this.claimProject(path), pending: 0, retained: false };
      this.storageClaims.set(path, claim);
    }
    return claim;
  }

  private reserveStorage(path: string) {
    const claim = this.storageClaim(path);
    claim.pending++;
    let finished = false;
    return (retain: boolean) => {
      if (finished) return;
      finished = true;
      claim.retained ||= retain;
      if (--claim.pending === 0 && !claim.retained) {
        claim.release();
        this.storageClaims.delete(path);
      }
    };
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.authority.initialize();
    await this.processState.initialize();
    try {
      this.registry = registrySchema.parse(
        JSON.parse((await readLocalFile(join(this.directory, "projects.json"))).toString("utf8")),
      );
    } catch (error) {
      if (!missing(error)) throw new Error("The local project registry could not be read.");
    }
  }

  get draftImportDirectory() {
    return join(this.directory, "draft-imports");
  }

  get projects() {
    return this.registry.projects;
  }
  get activeProjectId() {
    return this.registry.activeProjectId;
  }

  project(projectId: string) {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Open this project before accessing its files.");
    return project;
  }

  async open(directory: string, cloudName?: string) {
    const project = await this.register(directory, cloudName);
    return this.snapshot(project.id);
  }

  /** Register native-selected storage without decoding every saved conversation. */
  async register(directory: string, cloudName?: string): Promise<Project> {
    const path = await realpath(directory);
    if (!(await stat(path)).isDirectory()) throw new Error("Select a project directory.");
    if (!cloudName && this.projects.some((project) => project.path === path && project.cloud))
      throw new Error("Open this cloud workspace through your account instead.");
    const project: Project = {
      id: randomUUID(),
      name: cloudName ?? basename(path),
      path,
      openedAt: new Date().toISOString(),
      ...(cloudName ? { cloud: true } : {}),
    };
    const finishClaim = this.reserveStorage(path);
    try {
      await this.prepare(project);
      const metadataPath = join(path, ".tidy", "project.json");
      try {
        await writeFile(metadataPath, JSON.stringify({ version: 1, id: project.id }), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(metadataPath);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Project metadata must be a regular file.");
        project.id = z
          .object({ version: z.literal(1), id })
          .parse(await this.read(metadataPath)).id;
      }
      const previous = this.projects.find((item) => item.id === project.id);
      if (previous && previous.path !== path) {
        const previousPath = await realpath(previous.path).catch((error) => {
          if (missing(error)) return null;
          throw error;
        });
        if (previousPath && previousPath !== path) {
          // A copied identity must not redirect a registered project's active jobs or data.
          project.id = randomUUID();
          await this.atomicWrite(metadataPath, { version: 1, id: project.id });
        }
      }
      if (!cloudName && this.projects.some((project) => project.path === path && project.cloud))
        throw new Error("Open this cloud workspace through your account instead.");
      const previousRegistry = this.registry;
      const nextRegistry = {
        ...previousRegistry,
        projects: [project, ...this.projects.filter((item) => item.id !== project.id)].slice(
          0,
          100,
        ),
        activeProjectId: cloudName ? previousRegistry.activeProjectId : project.id,
      };
      this.registry = nextRegistry;
      try {
        await this.writeRegistry();
      } catch (error) {
        if (this.registry === nextRegistry) this.registry = previousRegistry;
        throw error;
      }
      finishClaim(true);
      return project;
    } catch (error) {
      finishClaim(false);
      throw error;
    }
  }

  /** Forget a local registration; project files and storage ownership remain intact. */
  async remove(projectId: string) {
    const project = this.project(projectId);
    if (project.cloud) throw new Error("Cloud workspaces cannot be removed from this list.");
    const previous = this.registry;
    const next = {
      ...previous,
      projects: previous.projects.filter((item) => item.id !== projectId),
      activeProjectId: previous.activeProjectId === projectId ? null : previous.activeProjectId,
    };
    this.registry = next;
    try {
      await this.writeRegistry();
    } catch (error) {
      if (this.registry === next) this.registry = previous;
      throw error;
    }
  }

  async select(projectId: string) {
    const project = this.project(projectId);
    if ((await realpath(project.path)) !== project.path)
      throw new Error("The project directory has moved. Open it again.");
    const snapshot = await this.snapshot(projectId);
    this.project(projectId);
    this.registry.activeProjectId = projectId;
    await this.writeRegistry();
    return snapshot;
  }

  private async prepare(project: Project) {
    if ((await realpath(project.path)) !== project.path)
      throw new Error("The project directory has moved. Open it again.");
    for (const name of ["", "threads", "designs", "assets", "folders", "attachments"]) {
      const path = join(project.path, ".tidy", name);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Project .tidy storage must be a real directory.");
    }
    try {
      await writeFile(
        join(project.path, ".tidy", ".gitignore"),
        "/threads/\n/attachments/\n/project.json\n",
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ignorePath = join(project.path, ".tidy", ".gitignore");
      const info = await lstat(ignorePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("Project ignore rules must be a regular file.");
      const required = ["/threads/", "/attachments/", "/project.json"];
      const rules = (await readLocalFile(ignorePath, 64 * 1024)).toString("utf8").split(/\r?\n/);
      // Append protections last so earlier negation rules cannot override them.
      if (rules.slice(-4).join("\n") !== [...required, ""].join("\n"))
        await appendFile(ignorePath, `\n${required.join("\n")}\n`);
    }
  }

  async storagePath(
    projectId: string,
    kind: "threads" | "designs" | "assets" | "folders" | "attachments",
    fileId?: string,
  ) {
    const project = this.project(projectId);
    if ((await realpath(project.path)) !== project.path)
      throw new Error("The project directory has moved. Open it again.");
    for (const directory of [join(project.path, ".tidy"), join(project.path, ".tidy", kind)]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Project .tidy storage must be a real directory.");
    }
    if (fileId) id.parse(fileId);
    const path = join(project.path, ".tidy", kind, ...(fileId ? [`${fileId}.json`] : []));
    if (fileId) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Project files must not be symbolic links.");
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const claim = this.storageClaim(project.path);
    if (claim.pending === 0) claim.retained = true;
    return path;
  }

  private async read(path: string) {
    return JSON.parse((await readLocalFile(path)).toString("utf8")) as unknown;
  }

  async addAttachment(projectId: string, name: string, dataUrl: string): Promise<AttachedFile> {
    const safeName = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .parse(name)
      .replace(/[\x00-\x1f\x7f/\\]/g, "_");
    const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
    if (!match || dataUrl.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 200)
      throw new Error("Choose a file under 20 MB.");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString("base64") !== match[2])
      throw new Error("This attachment could not be read, or exceeds 20 MB.");
    let mimeType = "application/octet-stream";
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      mimeType = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = "image/jpeg";
    else if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) mimeType = "image/gif";
    else if (
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    )
      mimeType = "image/webp";
    if (mimeType.startsWith("image/") && bytes.length > MAX_IMAGE_BYTES)
      throw new Error("Choose an image under 5 MB.");
    const suffix =
      (
        {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "image/gif": "gif",
        } as Record<string, string>
      )[mimeType] ??
      (/^[a-z0-9]{1,12}$/i.test(extname(safeName).slice(1))
        ? extname(safeName).slice(1).toLowerCase()
        : "bin");
    const attachment = { id: randomUUID(), name: safeName, mimeType, size: bytes.length };
    const directory = await this.storagePath(projectId, "attachments");
    await writeFile(join(directory, `${attachment.id}.file.${suffix}`), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    await this.atomicWrite(() => this.storagePath(projectId, "attachments", attachment.id), {
      ...attachment,
      suffix,
    });
    return {
      ...attachment,
      ...(mimeType.startsWith("image/")
        ? { previewUrl: `data:${mimeType};base64,${match[2]}` }
        : {}),
    };
  }

  async resolveAttachment(projectId: string, attachmentId: string) {
    const metadataPath = await this.storagePath(projectId, "attachments", attachmentId);
    const data = attachmentSchema
      .extend({ suffix: z.string().regex(/^[a-z0-9]{1,12}$/) })
      .parse(await this.read(metadataPath));
    if (data.id !== attachmentId) throw new Error("Attachment ID does not match its filename.");
    const directory = await this.storagePath(projectId, "attachments");
    const path = join(directory, `${data.id}.file.${data.suffix}`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Attachments must be regular files.");
    if (info.size !== data.size || info.size > MAX_ATTACHMENT_BYTES)
      throw new Error("This attachment changed on disk. Attach it again.");
    if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(data.mimeType) &&
      data.size > MAX_IMAGE_BYTES
    )
      throw new Error("Choose an image under 5 MB.");
    return { ...attachmentSchema.parse(data), path };
  }

  async readAttachment(projectId: string, attachmentId: string): Promise<AttachedFile> {
    const file = await this.resolveAttachment(projectId, attachmentId);
    const { path, ...value } = file;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value.mimeType))
      return value;
    if (value.size > MAX_IMAGE_BYTES) throw new Error("Choose an image under 5 MB.");
    return {
      ...value,
      previewUrl: `data:${value.mimeType};base64,${(await readLocalFile(path, MAX_IMAGE_BYTES)).toString("base64")}`,
    };
  }

  async threadExists(projectId: string, threadId: string) {
    const path = await this.storagePath(projectId, "threads", threadId);
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async readThread(projectId: string, threadId: string) {
    const thread = threadSchema.parse(
      await this.read(await this.storagePath(projectId, "threads", threadId)),
    );
    return this.authorizeThread({ thread, projectId, threadId });
  }

  private async authorizeThread<T extends Thread | ThreadSummary>({
    thread,
    projectId,
    threadId,
  }: {
    thread: T;
    projectId: string;
    threadId: string;
  }): Promise<T> {
    if (thread.projectId !== projectId || thread.id !== threadId)
      throw new Error("This thread belongs to another project.");
    const authority = await this.authority.read(this.project(projectId).path, thread);
    if (authority && authority.harness !== thread.harness)
      throw new Error("This thread's harness changed on disk. Start a new thread.");
    await this.assertThreadExecution(thread);
    if ("messages" in thread) thread.sessionId = authority?.sessionId;
    const settings = { ...thread.settings };
    delete settings.permissionMode;
    thread.settings =
      authority?.permissionMode || Object.keys(settings).length
        ? { ...settings, permissionMode: authority?.permissionMode }
        : undefined;
    return thread;
  }

  async assertThreadExecution(
    thread: Pick<Thread, "id" | "projectId" | "executionProjectId">,
    allowUnbound = false,
  ) {
    const authority = await this.authority.read(this.project(thread.projectId).path, thread);
    if (!authority && allowUnbound) return;
    if (
      thread.executionProjectId !== authority?.executionProjectId ||
      (authority?.executionProjectId &&
        this.project(authority.executionProjectId).path !== authority.executionProjectPath)
    )
      throw new Error("This thread's execution project changed. Start a new thread.");
  }

  writeThread(thread: Thread) {
    const value = threadSchema.parse(thread);
    const portable = { ...value };
    delete portable.sessionId;
    if (portable.settings) {
      const settings = { ...portable.settings };
      delete settings.permissionMode;
      portable.settings = Object.keys(settings).length ? settings : undefined;
    }
    const textLength =
      value.messages.reduce((total, message) => total + message.text.length, 0) +
      (value.queuedMessages?.reduce((total, message) => total + message.text.length, 0) ?? 0) +
      (value.toolActivities?.reduce((total, tool) => total + toolLogSize(tool), 0) ?? 0);
    const encoded =
      textLength >= 256 * 1024
        ? () => projectCompute.encodeThread(portable)
        : JSON.stringify(portable, null, 2);
    return this.writeEncoded(async () => {
      const path = await this.storagePath(value.projectId, "threads", value.id);
      await this.authority.write(
        this.project(value.projectId).path,
        value,
        value.executionProjectId ? this.project(value.executionProjectId).path : undefined,
      );
      return path;
    }, encoded);
  }

  async readDesign(
    projectId: string,
    designId: string,
    includeAssets = true,
    background = false,
  ): Promise<LocalDesign> {
    const cached = await this.parsedDesign(projectId, designId, background);
    // Renderer-facing callers own their copy; sync keeps an immutable reference.
    const document = includeAssets ? structuredClone(cached.document) : cached.document;
    return {
      id: cached.id,
      name: cached.name,
      folderId: cached.folderId,
      nodeCount: cached.nodeCount,
      path: cached.path,
      updatedAt: cached.updatedAt,
      document,
      version: cached.version,
      assets: Object.fromEntries(
        (includeAssets ? documentAssetIds(document) : []).map((assetId) => [
          assetId,
          this.assetURL(projectId, assetId),
        ]),
      ),
    };
  }

  async readDesignIfChanged(projectId: string, designId: string, version: string) {
    const cached = await this.parsedDesign(projectId, designId);
    if (cached.version === version) return null;
    return this.readDesign(projectId, designId);
  }

  private async parsedDesign(projectId: string, designId: string, background = false) {
    const path = await this.storagePath(projectId, "designs", designId);
    const stamp = designFileStamp(await stat(path, { bigint: true }));
    let cached = this.designCache.get(path);
    if (!cached || cached.stamp !== stamp) {
      // Share concurrent decodes of the same disk state, including card/open races.
      const key = `${path}:${stamp}`;
      let read = this.designReads.get(key);
      if (!read) {
        read = projectCompute.readFile(path, background);
        this.designReads.set(key, read);
        void read.finally(() => this.designReads.delete(key)).catch(() => {});
      } else if (!background) projectCompute.prioritizeFile(path);
      cached = await read;
      this.designCache.delete(path);
      this.designCache.set(path, cached);
      this.trimDesignCache();
      this.cacheSummary(path, summarizeDesignFile(cached));
    } else {
      this.designCache.delete(path);
      this.designCache.set(path, cached);
    }
    return cached;
  }

  private trimDesignCache() {
    // Bound retained scene complexity as well as the number of open files.
    let nodes = 0;
    let bytes = 0;
    for (const file of this.designCache.values()) {
      nodes += file.document.nodes.length;
      bytes += file.bytes;
    }
    while (
      this.designCache.size > 16 ||
      ((nodes > 40_000 || bytes > 32 * 1024 * 1024) && this.designCache.size > 1)
    ) {
      const oldest = this.designCache.keys().next().value!;
      nodes -= this.designCache.get(oldest)!.document.nodes.length;
      bytes -= this.designCache.get(oldest)!.bytes;
      this.designCache.delete(oldest);
    }
  }

  private assetURL(projectId: string, assetId: string) {
    return `${this.assetBase}/${id.parse(projectId)}/${id.parse(assetId)}`;
  }

  private cacheSummary(path: string, summary: DesignFileSummary) {
    this.summaryCache.delete(path);
    this.summaryCache.set(path, summary);
    while (this.summaryCache.size > 1000)
      this.summaryCache.delete(this.summaryCache.keys().next().value!);
  }

  private async designSummary(projectId: string, designId: string) {
    const path = await this.storagePath(projectId, "designs", designId);
    const stamp = designFileStamp(await stat(path, { bigint: true }));
    let cached = this.summaryCache.get(path);
    if (!cached || cached.stamp !== stamp) {
      const key = `${path}:${stamp}`;
      let read = this.summaryReads.get(key);
      if (!read) {
        const full = this.designReads.get(key);
        read = full ? full.then(summarizeDesignFile) : projectCompute.readSummary(path);
        this.summaryReads.set(key, read);
        void read.finally(() => this.summaryReads.delete(key)).catch(() => {});
      }
      cached = await read;
      this.cacheSummary(path, cached);
    }
    return cached;
  }
  /** Harness context needs validated names and paths, never a scene IPC transfer. */
  async readDesignReference(projectId: string, designId: string) {
    const { id, name, path } = await this.designSummary(projectId, designId);
    return { id, name, path };
  }
  async designStamp(projectId: string, designId: string) {
    return designFileStamp(
      await stat(await this.storagePath(projectId, "designs", designId), { bigint: true }),
    );
  }
  async designIdentity(projectId: string, designId: string) {
    const { stamp, version, name } = await this.designSummary(projectId, designId);
    return { stamp, version, name };
  }

  async createDesign(
    projectId: string,
    imported?: { name: string; document: unknown },
    folderId: string | null = null,
  ) {
    if (folderId !== null) await this.readFolder(projectId, folderId);
    const document = imported ? parseDesignDocument(imported.document) : blankDesignDocument();
    if (!imported) {
      document.nodes.push({
        id: randomUUID(),
        parentId: null,
        pageId: document.pages[0].id,
        type: "artboard",
        name: "Frame",
        visible: true,
        locked: false,
        box: { x: 0, y: 0, width: 800, height: 600 },
        layout: "absolute",
        style: { fill: "#ffffff" },
      });
    }
    const designId = randomUUID();
    const name =
      imported?.name.slice(0, 120) || `Design ${(await this.designs(projectId)).length + 1}`;
    await this.atomicWrite(await this.storagePath(projectId, "designs", designId), {
      id: designId,
      name,
      folderId,
      document: parseDesignDocument(document),
    });
    this.analytics?.({
      name: "design_file_created",
      storage: this.project(projectId).cloud ? "cloud" : "local",
      kind: imported ? "import" : "new",
    });
    return this.readDesign(projectId, designId);
  }

  async updateDesign(input: {
    projectId: string;
    designId: string;
    expectedVersion: string;
    document?: unknown;
    name?: string;
    folderId?: string | null;
  }) {
    const document = input.document === undefined ? undefined : parseDesignDocument(input.document);
    const name =
      input.name === undefined ? undefined : z.string().trim().min(1).max(120).parse(input.name);
    let result!: LocalDesign;
    const next = this.writes.then(async () => {
      const current = await this.readDesign(input.projectId, input.designId, false);
      if (current.version !== input.expectedVersion)
        throw new Error(
          "This design changed on disk. The latest version has been loaded; try your edit again.",
        );
      if (input.folderId !== undefined && input.folderId !== null)
        await this.readFolder(input.projectId, input.folderId);
      const data = {
        id: current.id,
        folderId: input.folderId === undefined ? (current.folderId ?? null) : input.folderId,
        name: name ?? current.name,
        document: document ?? current.document,
      };
      const path = await this.storagePath(input.projectId, "designs", input.designId);
      await this.writeAtomicFile(path, JSON.stringify(data, null, 2));
      result = await this.readDesign(input.projectId, input.designId);
    });
    this.writes = next.catch(() => {});
    await next;
    return result;
  }

  async uploadDesignAsset(projectId: string, dataUrl: string) {
    if (
      !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
      dataUrl.length > 3_000_000
    )
      throw new Error("Choose a PNG, JPEG, WebP or SVG image under 2 MB.");
    const assetId = randomUUID();
    await this.atomicWrite(() => this.storagePath(projectId, "assets", assetId), { dataUrl });
    return { assetId, url: this.assetURL(projectId, assetId) };
  }

  /** Sync uses the same bounded local asset format, without changing portable design IDs. */
  async readSyncAsset(projectId: string, assetId: string): Promise<string | undefined> {
    try {
      return z
        .object({ dataUrl: z.string().max(3_000_000) })
        .parse(await this.read(await this.storagePath(projectId, "assets", assetId))).dataUrl;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async cacheSyncAsset(projectId: string, assetId: string, dataUrl: string) {
    if (
      !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
      dataUrl.length > 3_000_000
    )
      throw new Error("Unsupported cloud image.");
    const previous = await this.readSyncAsset(projectId, assetId);
    if (previous !== undefined) {
      if (previous !== dataUrl)
        throw new Error("A local image has changed. Keep both copies to continue.");
      return;
    }
    await this.atomicWrite(() => this.storagePath(projectId, "assets", assetId), { dataUrl });
  }

  async designs(projectId: string) {
    const directory = await this.storagePath(projectId, "designs");
    const files = (await readdir(directory)).filter(
      (name) => id.safeParse(name.replace(/\.json$/, "")).success && name.endsWith(".json"),
    );
    const designs = await Promise.all(
      files.map(async (file) => {
        try {
          const design = await this.designSummary(projectId, file.slice(0, -5));
          return {
            id: design.id,
            name: design.name,
            folderId: design.folderId,
            nodeCount: design.nodeCount,
            path: design.path,
            updatedAt: design.updatedAt,
          };
        } catch {
          return null;
        }
      }),
    );
    return designs
      .filter((value) => value !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readFolder(projectId: string, folderId: string): Promise<DesignFolder> {
    const path = await this.storagePath(projectId, "folders", folderId);
    const data = z
      .object({ id, name: z.string().trim().min(1).max(120) })
      .parse(await this.read(path));
    if (data.id !== folderId) throw new Error("Folder ID does not match its filename.");
    return { ...data, updatedAt: (await stat(path)).mtime.toISOString() };
  }

  async folders(projectId: string): Promise<DesignFolder[]> {
    const directory = await this.storagePath(projectId, "folders");
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith(".json") && id.safeParse(name.slice(0, -5)).success,
    );
    const folders = await Promise.all(
      files.map(async (name) => {
        try {
          return await this.readFolder(projectId, name.slice(0, -5));
        } catch {
          return null;
        }
      }),
    );
    return folders
      .filter((value) => value !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createFolder(projectId: string, name: string) {
    const folderId = randomUUID();
    const value = { id: folderId, name: z.string().trim().min(1).max(120).parse(name) };
    await this.atomicWrite(() => this.storagePath(projectId, "folders", folderId), value);
    return this.readFolder(projectId, folderId);
  }

  async renameFolder(projectId: string, folderId: string, name: string) {
    const value = { id: folderId, name: z.string().trim().min(1).max(120).parse(name) };
    await this.atomicWrite(async () => {
      await this.readFolder(projectId, folderId);
      return this.storagePath(projectId, "folders", folderId);
    }, value);
    return this.readFolder(projectId, folderId);
  }

  private async threadSummaries(projectId: string) {
    const directory = await this.storagePath(projectId, "threads");
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith(".json") && id.safeParse(name.slice(0, -5)).success,
    );
    const threads = await Promise.all(
      files.map(async (file) => {
        try {
          return await this.threadSummary(projectId, file.slice(0, -5));
        } catch {
          return null;
        }
      }),
    );
    return threads
      .filter((value) => value !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async threadSummary(projectId: string, threadId: string): Promise<ThreadSummary> {
    const path = await this.storagePath(projectId, "threads", threadId);
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) throw new Error("Project files must not be symbolic links.");
    const stamp = designFileStamp(info);
    const cached = this.threadSummaryCache.get(path);
    if (cached?.stamp === stamp) {
      const summary = structuredClone(cached.summary);
      await this.authorizeThread({ thread: summary, projectId, threadId });
      this.threadSummaryCache.delete(path);
      this.threadSummaryCache.set(path, cached);
      return summary;
    }
    this.threadSummaryCache.delete(path);
    const summary =
      info.size > 64n * 1024n
        ? await this.authorizeThread({
            thread: await projectCompute.readThreadSummary(path),
            projectId,
            threadId,
          })
        : summarizeThread(await this.readThread(projectId, threadId));
    if (designFileStamp(await lstat(path, { bigint: true })) === stamp) {
      this.threadSummaryCache.set(path, { stamp, summary: structuredClone(summary) });
      while (this.threadSummaryCache.size > 1000) {
        const oldest = this.threadSummaryCache.keys().next().value;
        if (oldest === undefined) break;
        this.threadSummaryCache.delete(oldest);
      }
    }
    return summary;
  }

  async snapshot(projectId: string): Promise<ProjectSnapshot> {
    const project = this.project(projectId);
    const [threads, designs, folders] = await Promise.all([
      this.threadSummaries(projectId),
      this.designs(projectId),
      this.folders(projectId),
    ]);
    return { project, threads, designs, folders };
  }

  async recover() {
    for (const project of this.projects) {
      let finishClaim: ((retain: boolean) => void) | undefined;
      try {
        finishClaim = this.reserveStorage(await realpath(project.path));
        await this.prepare(project);
        const summaries = await this.threadSummaries(project.id);
        for (const summary of summaries) {
          if (summary.status !== "running") continue;
          const thread = await this.readThread(project.id, summary.id);
          await this.writeThread({
            ...thread,
            status: "interrupted",
            revision: thread.revision + 1,
            pendingApprovals: undefined,
            activity: undefined,
            toolActivities: thread.toolActivities?.map((tool) =>
              tool.status === "running" ? { ...tool, status: "interrupted" as const } : tool,
            ),
            error:
              "The backend stopped during this run. Check the workspace before sending a message to continue.",
          });
        }
        finishClaim(true);
      } catch {
        finishClaim?.(false);
        /* A removable or renamed project can be opened again later. */
      }
    }
  }

  flush() {
    return this.writes;
  }

  private writeRegistry() {
    return this.atomicWrite(join(this.directory, "projects.json"), this.registry);
  }

  private async writeAtomicFile(path: string, json: string | Uint8Array) {
    if ((typeof json === "string" ? Buffer.byteLength(json) : json.byteLength) > 16 * 1024 * 1024)
      throw new Error("The local project file reached its size limit.");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, json, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private atomicWrite(target: string | (() => Promise<string>), value: unknown) {
    return this.writeEncoded(target, JSON.stringify(value, null, 2));
  }

  private writeEncoded(
    target: string | (() => Promise<string>),
    encoded: string | (() => Promise<Uint8Array>),
  ) {
    if (typeof encoded === "string" && Buffer.byteLength(encoded) > 16 * 1024 * 1024)
      return Promise.reject(new Error("The local project file reached its size limit."));
    const next = this.writes.then(async () => {
      const json = typeof encoded === "string" ? encoded : await encoded();
      const path = typeof target === "string" ? target : await target();
      await this.writeAtomicFile(path, json);
    });
    this.writes = next.catch(() => {});
    return next;
  }
}
