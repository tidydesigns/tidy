import { createHash, randomUUID } from "node:crypto";
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
} from "../shared/attachments";
import type {
  DesignFolder,
  LocalDesign,
  Project,
  ProjectSnapshot,
  Thread,
} from "../shared/contracts";
import { summarizeThread } from "../shared/thread-updates";
import { ThreadAuthority } from "./thread-authority";
import { readLocalFile } from "./local-files";

import { storedThreadSchema as threadSchema } from "../shared/contracts";

const id = z.string().uuid();
const registrySchema = z.object({
  version: z.literal(1),
  activeProjectId: z.string().nullable(),
  projects: z
    .array(z.object({ id: z.string(), name: z.string(), path: z.string(), openedAt: z.string() }))
    .max(100),
});

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
/** Project directories are explicitly selected on the host, then addressed by IDs. */
export class ProjectStore {
  private registry: z.infer<typeof registrySchema> = {
    version: 1,
    activeProjectId: null,
    projects: [],
  };
  private writes = Promise.resolve();

  private authority: ThreadAuthority;
  constructor(private directory: string) {
    this.authority = new ThreadAuthority(join(directory, "thread-authority"));
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.authority.initialize();
    try {
      this.registry = registrySchema.parse(
        JSON.parse((await readLocalFile(join(this.directory, "projects.json"))).toString("utf8")),
      );
    } catch (error) {
      if (!missing(error)) throw new Error("The local project registry could not be read.");
    }
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

  async open(directory: string) {
    const path = await realpath(directory);
    if (!(await stat(path)).isDirectory()) throw new Error("Select a project directory.");
    const project: Project = {
      id: randomUUID(),
      name: basename(path),
      path,
      openedAt: new Date().toISOString(),
    };
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
      project.id = z.object({ version: z.literal(1), id }).parse(await this.read(metadataPath)).id;
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
    this.registry.projects = [
      project,
      ...this.projects.filter((item) => item.id !== project.id),
    ].slice(0, 100);
    this.registry.activeProjectId = project.id;
    await this.writeRegistry();
    return this.snapshot(project.id);
  }

  async select(projectId: string) {
    const project = this.project(projectId);
    if ((await realpath(project.path)) !== project.path)
      throw new Error("The project directory has moved. Open it again.");
    const snapshot = await this.snapshot(projectId);
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
    if (thread.projectId !== projectId || thread.id !== threadId)
      throw new Error("This thread belongs to another project.");
    const authority = await this.authority.read(this.project(projectId).path, thread);
    if (authority && authority.harness !== thread.harness)
      throw new Error("This thread's harness changed on disk. Start a new thread.");
    thread.sessionId = authority?.sessionId;
    const settings = { ...thread.settings };
    delete settings.permissionMode;
    thread.settings =
      authority?.permissionMode || Object.keys(settings).length
        ? { ...settings, permissionMode: authority?.permissionMode }
        : undefined;
    return thread;
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
    return this.atomicWrite(async () => {
      const path = await this.storagePath(value.projectId, "threads", value.id);
      await this.authority.write(this.project(value.projectId).path, value);
      return path;
    }, portable);
  }

  async readDesign(
    projectId: string,
    designId: string,
    includeAssets = true,
  ): Promise<LocalDesign> {
    const path = await this.storagePath(projectId, "designs", designId);
    const data = z
      .object({
        id,
        name: z.string().min(1).max(120),
        document: z.unknown(),
        folderId: id.nullable().optional(),
      })
      .parse(await this.read(path));
    if (data.id !== designId) throw new Error("Design ID does not match its filename.");
    const document = parseDesignDocument(data.document);
    return {
      id: data.id,
      name: data.name,
      folderId: data.folderId ?? null,
      nodeCount: document.nodes.length,
      path,
      updatedAt: (await stat(path)).mtime.toISOString(),
      document,
      version: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      assets: Object.fromEntries(
        await Promise.all(
          (includeAssets ? [...documentAssetIds(document)] : []).map(async (assetId) => {
            try {
              const asset = z
                .object({ dataUrl: z.string() })
                .parse(await this.read(await this.storagePath(projectId, "assets", assetId)));
              return [assetId, asset.dataUrl];
            } catch {
              return [assetId, ""];
            }
          }),
        ),
      ),
    };
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
    return { assetId, url: dataUrl };
  }

  async designs(projectId: string) {
    const directory = await this.storagePath(projectId, "designs");
    const files = (await readdir(directory)).filter(
      (name) => id.safeParse(name.replace(/\.json$/, "")).success && name.endsWith(".json"),
    );
    const designs = await Promise.all(
      files.map(async (file) => {
        try {
          const design = await this.readDesign(projectId, file.slice(0, -5), false);
          return {
            id: design.id,
            name: design.name,
            folderId: design.folderId,
            nodeCount: design.document.nodes.length,
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

  async snapshot(projectId: string): Promise<ProjectSnapshot> {
    const project = this.project(projectId);
    const directory = await this.storagePath(projectId, "threads");
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith(".json") && id.safeParse(name.slice(0, -5)).success,
    );
    const threads = await Promise.all(
      files.map(async (file) => {
        try {
          return summarizeThread(await this.readThread(projectId, file.slice(0, -5)));
        } catch {
          return null;
        }
      }),
    );
    return {
      project,
      threads: threads
        .filter((value) => value !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      designs: await this.designs(projectId),
      folders: await this.folders(projectId),
    };
  }

  async recover() {
    for (const project of this.projects) {
      try {
        await this.prepare(project);
        const snapshot = await this.snapshot(project.id);
        for (const summary of snapshot.threads) {
          if (summary.status !== "running") continue;
          const thread = await this.readThread(project.id, summary.id);
          await this.writeThread({
            ...thread,
            status: "interrupted",
            activity: undefined,
            toolActivities: thread.toolActivities?.map((tool) =>
              tool.status === "running" ? { ...tool, status: "interrupted" as const } : tool,
            ),
            error: "The app closed during this run. Send a message to continue.",
          });
        }
      } catch {
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

  private async writeAtomicFile(path: string, json: string) {
    if (Buffer.byteLength(json) > 16 * 1024 * 1024)
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
    const json = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(json) > 16 * 1024 * 1024)
      return Promise.reject(new Error("The local project file reached its size limit."));
    const next = this.writes.then(async () => {
      const path = typeof target === "string" ? target : await target();
      await this.writeAtomicFile(path, json);
    });
    this.writes = next.catch(() => {});
    return next;
  }
}
