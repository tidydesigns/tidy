import { join } from "node:path";
import { rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

/** Native execution writes this private journal. Portable thread JSON cannot request execution. */
export class UpdateResumes {
  private changes: Promise<unknown> = Promise.resolve();
  private path: string;
  private generations = new Map<string, number>();
  constructor(directory: string) {
    this.path = join(directory, "update-resumes.json");
  }

  private async read() {
    try {
      return z
        .array(entrySchema)
        .max(1000)
        .parse(JSON.parse((await readLocalFile(this.path, 1024 * 1024)).toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private change<T>(operation: () => Promise<T>) {
    const next = this.changes.catch(() => {}).then(operation);
    this.changes = next;
    return next;
  }

  async list() {
    await this.changes;
    return this.read();
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
      await writePrivateJSON(
        this.path,
        entries.map((entry) => ({ ...entry, reason: "update" })),
        { durable: true },
      );
    });
  }

  stage(entries: UpdateResume[]) {
    return this.change(async () => {
      const previous = await this.read();
      const ids = new Set(entries.map((entry) => entry.threadId));
      const value = z
        .array(entrySchema)
        .max(1000)
        .parse([...previous.filter((entry) => !ids.has(entry.threadId)), ...entries]);
      await writePrivateJSON(this.path, value, { durable: true });
    });
  }

  /** Authorize both sides of the atomic thread rename if the process dies between writes. */
  checkpoint(entry: UpdateResume, generation = this.generation(entry.threadId)) {
    return this.change(async () => {
      if (generation !== this.generation(entry.threadId)) return;
      const entries = await this.read().catch(async (error: unknown) => {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        // Retain corrupt bytes for diagnosis; only the current native snapshot can rebuild intent.
        await rename(this.path, `${this.path}.corrupt-${randomUUID()}`);
        return [];
      });
      const previous = entries.find((item) => item.threadId === entry.threadId);
      const next = entrySchema.parse({
        ...entry,
        previousSignature: entry.previousSignature ?? previous?.signature,
      });
      if (generation !== this.generation(entry.threadId)) return;
      await writePrivateJSON(
        this.path,
        z
          .array(entrySchema)
          .max(1000)
          .parse([...entries.filter((item) => item.threadId !== entry.threadId), next]),
        { durable: true },
      );
    });
  }

  /** Discard obsolete intent only while it still matches the inspected checkpoint. */
  take(entry: UpdateResume) {
    return this.change(async () => {
      const entries = await this.read();
      if (
        !entries.some(
          (item) => item.threadId === entry.threadId && item.signature === entry.signature,
        )
      )
        return false;
      await writePrivateJSON(
        this.path,
        entries.filter((item) => item.threadId !== entry.threadId),
        {
          durable: true,
        },
      );
      return true;
    });
  }

  cancel(projectId: string, threadId: string) {
    this.generations.set(threadId, this.generation(threadId) + 1);
    return this.change(async () => {
      let entries: UpdateResume[];
      try {
        entries = await this.read();
      } catch {
        // Unreadable restart intent cannot be trusted or allowed to block an explicit Stop.
        await writePrivateJSON(this.path, [], { durable: true });
        return;
      }
      const remaining = entries.filter(
        (entry) => entry.projectId !== projectId || entry.threadId !== threadId,
      );
      if (remaining.length !== entries.length)
        await writePrivateJSON(this.path, remaining, { durable: true });
    });
  }

  clear() {
    for (const [id, generation] of this.generations) this.generations.set(id, generation + 1);
    // Replace rather than parse: malformed recovery data must not prevent ordinary shutdown.
    return this.change(() => writePrivateJSON(this.path, [], { durable: true }));
  }
}
