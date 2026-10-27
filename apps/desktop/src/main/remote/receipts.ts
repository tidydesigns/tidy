import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { remoteRequestSchema, type RemoteRequest } from "../../shared/remote";

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending"), fingerprint: z.string() }),
  z.object({ kind: z.literal("complete"), fingerprint: z.string(), response: responseSchema }),
]);
const uuid = z.string().uuid();
type Response = z.infer<typeof responseSchema>;
export class RequestReceipts {
  private running = new Map<string, Promise<Response>>();
  constructor(private directory: string) {}
  private path(clientId: string, id: string) {
    return join(this.directory, `${uuid.parse(clientId)}-${uuid.parse(id)}.json`);
  }
  async lookup(clientId: string, id: string) {
    try {
      return receiptSchema.parse(JSON.parse(await readFile(this.path(clientId, id), "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async status(clientId: string, id: string) {
    const receipt = await this.lookup(clientId, id);
    if (!receipt) return { kind: "missing" as const };
    if (receipt.kind === "complete")
      return { kind: "complete" as const, response: receipt.response };
    return {
      kind: this.running.has(`${this.path(clientId, id)}:${receipt.fingerprint}`)
        ? ("pending" as const)
        : ("interrupted" as const),
    };
  }
  async execute(
    clientId: string,
    input: RemoteRequest,
    action: () => Promise<unknown>,
  ): Promise<Response> {
    const request = remoteRequestSchema.parse(input);
    const path = this.path(clientId, request.id);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const key = `${path}:${fingerprint}`;
    const running = this.running.get(key);
    if (running) return running;
    const work = this.run({ path, fingerprint, clientId, request, action });
    this.running.set(key, work);
    try {
      return await work;
    } finally {
      this.running.delete(key);
    }
  }
  private async run({
    path,
    fingerprint,
    clientId,
    request,
    action,
  }: {
    path: string;
    fingerprint: string;
    clientId: string;
    request: RemoteRequest;
    action: () => Promise<unknown>;
  }): Promise<Response> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ kind: "pending", fingerprint }));
        await file.sync();
      } finally {
        await file.close();
      }
      await this.syncDirectory();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const prior = await this.lookup(clientId, request.id);
      if (!prior || prior.fingerprint !== fingerprint)
        throw new Error("This command ID belongs to a different request.");
      if (prior.kind === "complete") return prior.response;
      throw new Error(
        "This operation may have completed before the backend restarted. Check the refreshed workspace before trying again.",
      );
    }
    let response: Response;
    try {
      response = { ok: true, data: await action() };
    } catch (error) {
      response = {
        ok: false,
        error: error instanceof Error ? error.message : "Remote operation failed.",
      };
    }
    const temporary = `${path}.tmp`;
    try {
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify({ kind: "complete", fingerprint, response }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await this.syncDirectory();
    } finally {
      await rm(temporary, { force: true });
    }
    return response;
  }
  private async syncDirectory() {
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
