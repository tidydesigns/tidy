import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { permissionModeSchema } from "../shared/permissions";
import type { Thread } from "../shared/contracts";
import { readLocalFile } from "./local-files";

const authoritySchema = z
  .object({
    harness: z.enum(["codex", "claude"]),
    sessionId: z.string().uuid().optional(),
    permissionMode: permissionModeSchema.optional(),
    executionProjectId: z.uuid().optional(),
    executionProjectPath: z.string().optional(),
  })
  .strict();
type Authority = z.infer<typeof authoritySchema>;

/** Project JSON is portable data, never authority to grant access or resume native sessions. */
export class ThreadAuthority {
  private cache = new Map<string, Authority>();
  constructor(private directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Private thread state must use a real directory.");
  }

  private key(projectPath: string, thread: Thread) {
    return createHash("sha256")
      .update(JSON.stringify([projectPath, thread.projectId, thread.id]))
      .digest("hex");
  }

  async read(projectPath: string, thread: Thread): Promise<Authority | undefined> {
    const key = this.key(projectPath, thread);
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      const value = authoritySchema.parse(
        JSON.parse(
          (await readLocalFile(join(this.directory, `${key}.json`), 4096)).toString("utf8"),
        ),
      );
      this.cache.set(key, value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  /** Called only with trusted in-memory state after a UI action or native protocol update. */
  async write(projectPath: string, thread: Thread, executionProjectPath?: string) {
    const key = this.key(projectPath, thread);
    const previous = await this.read(projectPath, thread);
    if (
      previous &&
      (previous.executionProjectId !== thread.executionProjectId ||
        previous.executionProjectPath !== executionProjectPath)
    )
      throw new Error("This thread's execution project changed. Start a new thread.");
    const value = authoritySchema.parse({
      harness: thread.harness,
      executionProjectId: thread.executionProjectId,
      executionProjectPath,
      sessionId: thread.sessionId,
      permissionMode: thread.settings?.permissionMode,
    });
    if (JSON.stringify(this.cache.get(key)) === JSON.stringify(value)) return;
    const path = join(this.directory, `${key}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      this.cache.set(key, value);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
