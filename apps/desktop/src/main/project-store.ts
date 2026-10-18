import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { blankDesignDocument, parseDesignDocument, documentAssetIds } from "@tidy/design/document";
import { z } from "zod";
import type { LocalDesign, Project, ProjectSnapshot, Thread } from "../shared/contracts";
import { summarizeThread } from "../shared/contracts";

const id = z.string().uuid();
const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(1_000_000),
});
export const threadSchema = z.object({
  revision: z.number().int().min(0).default(0),
  id,
  projectId: id,
  title: z.string().max(120),
  harness: z.enum(["codex", "claude"]),
  sessionId: id.optional(),
  doneAt: z.string().datetime().optional(),
  designIds: z.array(id).max(20),
  messages: z.array(messageSchema).max(1000),
  status: z.enum(["idle", "running", "completed", "stopped", "failed", "interrupted"]),
  activity: z.string().max(500).optional(),
  error: z.string().max(4000).optional(),
  updatedAt: z.string().datetime(),
});
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
/** Paths are selected in a native dialog and then addressed exclusively by IDs. */
export class ProjectStore {
  private registry: z.infer<typeof registrySchema> = {
    version: 1,
    activeProjectId: null,
    projects: [],
  };
  private writes = Promise.resolve();

  constructor(private directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.registry = registrySchema.parse(
        JSON.parse(await readFile(join(this.directory, "projects.json"), "utf8")),
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
    for (const name of ["", "threads", "designs", "assets"]) {
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
      await writeFile(join(project.path, ".tidy", ".gitignore"), "/threads/\n/project.json\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async storagePath(projectId: string, kind: "threads" | "designs" | "assets", fileId?: string) {
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
    if ((await stat(path)).size > 16 * 1024 * 1024)
      throw new Error("The local project file is too large.");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  async readThread(projectId: string, threadId: string) {
    const thread = threadSchema.parse(
      await this.read(await this.storagePath(projectId, "threads", threadId)),
    );
    if (thread.projectId !== projectId || thread.id !== threadId)
      throw new Error("This thread belongs to another project.");
    return thread;
  }

  writeThread(thread: Thread) {
    const value = threadSchema.parse(thread);
    return this.atomicWrite(() => this.storagePath(value.projectId, "threads", value.id), value);
  }

  async readDesign(
    projectId: string,
    designId: string,
    includeAssets = true,
  ): Promise<LocalDesign> {
    const path = await this.storagePath(projectId, "designs", designId);
    const data = z
      .object({ id, name: z.string().min(1).max(120), document: z.unknown() })
      .parse(await this.read(path));
    if (data.id !== designId) throw new Error("Design ID does not match its filename.");
    const document = parseDesignDocument(data.document);
    return {
      id: data.id,
      name: data.name,
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

  async createDesign(projectId: string, imported?: { name: string; document: unknown }) {
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
      const data = {
        id: current.id,
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
    await writeFile(temporary, json, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
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
