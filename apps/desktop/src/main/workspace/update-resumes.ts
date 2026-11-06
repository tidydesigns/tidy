import { join } from "node:path";
import { lstat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { skillIdSchema } from "../../shared/contracts/skills";
import { readLocalFile } from "../platform/local-files";
import { writePrivateJSON } from "../remote/session-store";

const entrySchema = z.object({
  projectId: z.uuid(),
  threadId: z.uuid(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  previousSignature: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  automaticQueue: z.boolean(),
  reason: z.enum(["update", "restart", "provider"]).optional(),
  attempt: z.number().int().nonnegative().optional(),
  unknownAttempts: z.number().int().nonnegative().optional(),
  retryAt: z.string().datetime().optional(),
  background: z.boolean().optional(),
  submission: z
    .object({
      state: z.enum(["not-submitted", "unknown", "rejected", "accepted"]),
      messageId: z.uuid(),
      skillId: skillIdSchema.optional(),
    })
    .optional(),
});
export type UpdateResume = z.infer<typeof entrySchema>;
const journalSchema = z
  .array(entrySchema)
  .max(1000)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.threadId)).size === entries.length,
    "Recovery entries must have unique thread IDs.",
  );

/** Native execution writes this private journal. Portable thread JSON cannot request execution. */
export class UpdateResumes {
  private changes: Promise<unknown> = Promise.resolve();
  private path: string;
  private generations = new Map<string, number>();
  private writeFailed = false;
  private cached?: { version: string; entries: ReadonlyMap<string, UpdateResume> };
  constructor(directory: string) {
    this.path = join(directory, "update-resumes.json");
  }

  private async version() {
    try {
      const info = await lstat(this.path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Recovery intent must be a regular private file.");
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.nlink}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  /** Reuse validated entries only while the private file's identity and timestamps match. */
  private async read(): Promise<ReadonlyMap<string, UpdateResume>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = await this.version();
      if (this.cached?.version === version) return this.cached.entries;
      this.cached = undefined;
      const entries =
        version === "missing"
          ? []
          : journalSchema.parse(
              JSON.parse((await readLocalFile(this.path, 1024 * 1024)).toString("utf8")),
            );
      if (version !== (await this.version())) continue;
      const indexed = new Map(entries.map((entry) => [entry.threadId, entry]));
      this.cached = { version, entries: indexed };
      return indexed;
    }
    throw new Error("Recovery intent changed while it was being read. Retry shortly.");
  }

  /** A changed journal must be reread once; never bind cached values to an external replacement. */
  private async write(entries: ReadonlyMap<string, UpdateResume>) {
    if (entries.size > 1000) throw new Error("Recovery intent reached its entry limit.");
    this.cached = undefined;
    this.writeFailed = true;
    await writePrivateJSON(this.path, [...entries.values()], { durable: true });
    this.writeFailed = false;
  }

  private change<T>(operation: () => Promise<T>) {
    const next = this.changes.catch(() => {}).then(operation);
    this.changes = next;
    return next;
  }

  async list() {
    await this.changes;
    return structuredClone([...(await this.read()).values()]);
  }

  async get(projectId: string, threadId: string) {
    await this.changes;
    const entry = (await this.read()).get(threadId);
    return entry?.projectId === projectId ? structuredClone(entry) : undefined;
  }

  /** Capture before asynchronous writes so Stop can fence every older checkpoint. */
  generation(threadId: string) {
    const generation = this.generations.get(threadId) ?? 0;
    this.generations.set(threadId, generation);
    return generation;
  }

  markUpdate() {
    return this.change(async () => {
      const entries = await this.read();
      if (!this.writeFailed && [...entries.values()].every((entry) => entry.reason === "update"))
        return;
      await this.write(
        new Map([...entries].map(([id, entry]) => [id, { ...entry, reason: "update" }])),
      );
    });
  }

  async stage(entries: UpdateResume[]) {
    const incoming = journalSchema.parse(entries);
    return this.change(async () => {
      const previous = await this.read();
      const value = new Map(previous);
      for (const entry of incoming) value.set(entry.threadId, entry);
      if (!this.writeFailed && isDeepStrictEqual(value, previous)) return;
      await this.write(value);
    });
  }

  /** Authorize both sides of the atomic thread rename if the process dies between writes. */
  async checkpoint(entry: UpdateResume, generation = this.generation(entry.threadId)) {
    entry = entrySchema.parse(entry);
    return this.change(async () => {
      if (generation !== this.generation(entry.threadId)) return;
      const entries = await this.read().catch(async (error: unknown) => {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        // Retain corrupt bytes for diagnosis; only the current native snapshot can rebuild intent.
        await rename(this.path, `${this.path}.corrupt-${randomUUID()}`);
        return new Map<string, UpdateResume>();
      });
      const previous = entries.get(entry.threadId);
      const next = entrySchema.parse({
        ...entry,
        previousSignature: entry.previousSignature ?? previous?.signature,
      });
      if (generation !== this.generation(entry.threadId)) return;
      if (!this.writeFailed && isDeepStrictEqual(previous, next)) return;
      const value = new Map(entries);
      value.set(entry.threadId, next);
      await this.write(value);
    });
  }

  /** Discard obsolete intent only while it still matches the inspected checkpoint. */
  take(entry: UpdateResume) {
    return this.change(async () => {
      const entries = await this.read();
      if (entries.get(entry.threadId)?.signature !== entry.signature) return false;
      const value = new Map(entries);
      value.delete(entry.threadId);
      await this.write(value);
      return true;
    });
  }

  cancel(projectId: string, threadId: string) {
    this.generations.set(threadId, this.generation(threadId) + 1);
    return this.change(async () => {
      let entries: ReadonlyMap<string, UpdateResume>;
      try {
        entries = await this.read();
      } catch {
        // Unreadable restart intent cannot be trusted or allowed to block an explicit Stop.
        await this.write(new Map());
        return;
      }
      if (entries.get(threadId)?.projectId !== projectId) {
        if (this.writeFailed) await this.write(entries);
        return;
      }
      const remaining = new Map(entries);
      remaining.delete(threadId);
      await this.write(remaining);
    });
  }

  clear() {
    for (const [id, generation] of this.generations) this.generations.set(id, generation + 1);
    // Replace rather than parse: malformed recovery data must not prevent ordinary shutdown.
    return this.change(() => this.write(new Map()));
  }
}
