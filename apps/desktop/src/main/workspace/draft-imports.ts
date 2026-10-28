import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { documentAssetIds, parseDesignDocument } from "@tidy/design/document";
import type { ProjectSnapshot } from "../../shared/contracts/desktop";
import type { DraftImport, DraftImportResult } from "../../shared/contracts/draft-import";
import { readLocalFile } from "../platform/local-files";
import { ProjectStore } from "./project-store";

const uuid = z.string().uuid();
const fileSchema = z.object({
  kind: z.enum(["assets", "attachments", "designs"]),
  name: z
    .string()
    .regex(/^[0-9a-f-]{36}\.(?:json|file\.[a-z0-9]+)$/)
    .refine((name) => uuid.safeParse(name.slice(0, 36)).success),
});
const journalSchema = z.object({
  projectId: uuid,
  id: uuid,
  state: z.enum(["staging", "publishing", "committed"]),
  files: z.array(fileSchema).max(1000),
});
type Journal = z.infer<typeof journalSchema>;

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class DraftImports {
  private queue = Promise.resolve();
  constructor(
    private store: ProjectStore,
    private authorize: (projectId: string) => Promise<void>,
  ) {}

  private serialize<T>(action: () => Promise<T>) {
    const work = this.queue.then(action);
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  recover(projectId: string) {
    return this.serialize(() => this.recoverProject(projectId));
  }

  private async directory() {
    const path = this.store.draftImportDirectory;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Draft import records must be a real directory.");
    return path;
  }

  private async save(journal: Journal) {
    const directory = await this.directory();
    const path = join(directory, `${journal.projectId}.${journal.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(journal));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(directory);
  }

  private async stagePath(journal: Journal) {
    const root = await this.store.storagePath(journal.projectId, "attachments");
    return join(root, `.import-${journal.id}`);
  }

  private async cleanup(journal: Journal) {
    const stage = await this.stagePath(journal);
    let exists = false;
    try {
      exists = (await realpath(stage)) === stage && (await lstat(stage)).isDirectory();
      if (!exists) throw new Error("The draft import folder has moved.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (exists && journal.state === "publishing") {
      for (const file of journal.files) {
        const source = join(stage, ".tidy", file.kind, file.name);
        const target = join(await this.store.storagePath(journal.projectId, file.kind), file.name);
        try {
          const [before, after] = await Promise.all([lstat(source), lstat(target)]);
          if (
            before.isFile() &&
            after.isFile() &&
            before.ino === after.ino &&
            before.dev === after.dev
          )
            await rm(target);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      for (const kind of ["attachments", "assets", "designs"] as const)
        await syncDirectory(await this.store.storagePath(journal.projectId, kind));
    }
    if (exists) await rm(stage, { recursive: true });
    await rm(join(await this.directory(), `${journal.projectId}.${journal.id}.json`), {
      force: true,
    });
  }

  private async recoverProject(projectId: string) {
    uuid.parse(projectId);
    const directory = await this.directory();
    for (const name of await readdir(directory)) {
      if (!name.startsWith(`${projectId}.`) || !name.endsWith(".json")) continue;
      const journal = journalSchema.parse(
        JSON.parse((await readLocalFile(join(directory, name), 200_000)).toString("utf8")),
      );
      if (name !== `${journal.projectId}.${journal.id}.json` || journal.projectId !== projectId)
        throw new Error("Invalid draft import record.");
      await this.cleanup(journal);
    }
  }

  import(input: DraftImport): Promise<DraftImportResult & { snapshot: ProjectSnapshot }> {
    return this.serialize(async () => {
      await this.authorize(input.projectId);
      await this.recoverProject(input.projectId);
      const journal: Journal = {
        projectId: input.projectId,
        id: randomUUID(),
        state: "staging",
        files: [],
      };
      const stage = await this.stagePath(journal);
      await this.save(journal);
      let owned = false;
      try {
        await mkdir(stage, { mode: 0o700 });
        owned = true;
        const staged = new ProjectStore(join(stage, "state"));
        await staged.initialize();
        const { project } = await staged.open(stage);
        const attachments = [];
        const designIds = [];
        for (const file of input.attachments)
          attachments.push(await staged.addAttachment(project.id, file.name, file.dataUrl));
        for (const design of input.designs) {
          const assets = new Map<string, string>();
          for (const id of documentAssetIds(design.document)) {
            const dataUrl = design.assets[id];
            if (!dataUrl)
              throw new Error("A design image is missing. Open the source design and try again.");
            assets.set(id, (await staged.uploadDesignAsset(project.id, dataUrl)).assetId);
          }
          const document = parseDesignDocument(
            JSON.parse(
              JSON.stringify(design.document, (key, value: unknown) =>
                key === "assetId" && typeof value === "string"
                  ? (assets.get(value) ?? value)
                  : value,
              ),
            ),
          );
          designIds.push(
            (await staged.createDesign(project.id, { name: design.name, document })).id,
          );
        }
        for (const kind of ["assets", "attachments", "designs"] as const) {
          const directory = await staged.storagePath(project.id, kind);
          for (const name of await readdir(directory)) {
            const entry = fileSchema.parse({ kind, name });
            const file = await open(
              join(directory, name),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const info = await file.stat();
              if (!info.isFile() || info.nlink !== 1) throw new Error("Invalid staged draft file.");
              await file.sync();
            } finally {
              await file.close();
            }
            journal.files.push(entry);
            if (journal.files.length > 1000)
              throw new Error("There are too many images to move together.");
          }
          await syncDirectory(directory);
        }
        await syncDirectory(join(stage, ".tidy"));
        await syncDirectory(stage);
        await syncDirectory(await this.store.storagePath(input.projectId, "attachments"));
        await this.authorize(input.projectId);
        journal.state = "publishing";
        await this.save(journal);
        for (const file of journal.files) {
          const destination = await this.store.storagePath(input.projectId, file.kind);
          await link(join(stage, ".tidy", file.kind, file.name), join(destination, file.name));
        }
        for (const kind of ["assets", "attachments", "designs"] as const)
          await syncDirectory(await this.store.storagePath(input.projectId, kind));
        const snapshot = await this.store.snapshot(input.projectId);
        await this.authorize(input.projectId);
        journal.state = "committed";
        await this.save(journal);
        return { attachments, designIds, snapshot };
      } catch (error) {
        if (!owned) {
          await rm(join(await this.directory(), `${journal.projectId}.${journal.id}.json`), {
            force: true,
          });
        } else {
          journal.state = journal.files.length ? "publishing" : "staging";
          await this.cleanup(journal);
        }
        throw error;
      } finally {
        if (journal.state === "committed") {
          try {
            await this.cleanup(journal);
          } catch {
            process.stderr.write(
              JSON.stringify({ event: "draft-import.cleanup-failed", projectId: input.projectId }) +
                "\n",
            );
          }
        }
      }
    });
  }
}
