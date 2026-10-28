import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, opendir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { projectSetupResultSchema } from "../../shared/contracts/workspace-response";
import { remoteRequestSchema, type RemoteRequest } from "../../shared/remote";

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine") }),
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }),
]);
const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending"), fingerprint: z.string(), scope: scopeSchema.optional() }),
  z.object({
    kind: z.literal("complete"),
    fingerprint: z.string(),
    scope: scopeSchema.optional(),
    response: responseSchema,
  }),
]);
const uuid = z.string().uuid();
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

type Response = z.infer<typeof responseSchema>;
type StoredResult = { scope?: z.infer<typeof scopeSchema>; response: Response };
type Authorize = (projectId: string) => Promise<void>;
export const unavailableReceiptResponse = {
  ok: false,
  error:
    "This command completed, but access to its stored result is unavailable. Check the refreshed workspace before trying another command.",
} satisfies Response;

async function disclose(result: StoredResult, authorize?: Authorize): Promise<Response> {
  if (result.scope?.kind === "machine") return result.response;
  if (result.scope?.kind === "project" && authorize) {
    try {
      await authorize(result.scope.projectId);
      return result.response;
    } catch {}
  }
  return unavailableReceiptResponse;
}
export class RequestReceipts {
  private running = new Map<string, Promise<StoredResult>>();
  private maintenance?: ReturnType<typeof setInterval>;
  private pruning?: Promise<void>;
  constructor(private directory: string) {}
  start() {
    if (this.maintenance) return;
    const prune = () =>
      void this.prune().catch(() => {
        process.stderr.write(JSON.stringify({ event: "receipts.prune-failed" }) + "\n");
      });
    prune();
    this.maintenance = setInterval(prune, PRUNE_INTERVAL_MS);
    this.maintenance.unref();
  }
  async close() {
    clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.pruning?.catch(() => {});
  }
  prune({ now = Date.now() }: { now?: number } = {}) {
    if (this.pruning) return this.pruning;
    const work = this.pruneCompleted(now).finally(() => {
      this.pruning = undefined;
    });
    this.pruning = work;
    return work;
  }
  private async pruneCompleted(now: number) {
    let directory;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      directory = await opendir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for await (const entry of directory) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/i.test(entry.name)) continue;
      const path = join(this.directory, entry.name);
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await file.stat();
        if (!metadata.isFile() || now - metadata.mtimeMs <= RECEIPT_RETENTION_MS) continue;
        const prefix = Buffer.alloc(32);
        const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
        if (!prefix.subarray(0, bytesRead).toString("utf8").startsWith('{"kind":"complete",'))
          continue;
        if ([...this.running.keys()].some((key) => key.startsWith(path + ":"))) continue;
        await rm(path, { force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      } finally {
        await file?.close();
      }
    }
  }
  private path(clientId: string, id: string) {
    return join(this.directory, `${uuid.parse(clientId)}-${uuid.parse(id)}.json`);
  }
  private async lookup(clientId: string, id: string) {
    try {
      return receiptSchema.parse(JSON.parse(await readFile(this.path(clientId, id), "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async status(clientId: string, id: string, authorize?: Authorize) {
    const receipt = await this.lookup(clientId, id);
    if (!receipt) return { kind: "missing" as const };
    if (receipt.kind === "complete")
      return { kind: "complete" as const, response: await disclose(receipt, authorize) };
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
    authorize?: Authorize,
  ): Promise<Response> {
    const request = remoteRequestSchema.parse(input);
    const path = this.path(clientId, request.id);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const key = `${path}:${fingerprint}`;
    const running = this.running.get(key);
    if (running) return disclose(await running, authorize);
    const work = this.run({ path, fingerprint, clientId, request, action });
    this.running.set(key, work);
    try {
      return await disclose(await work, authorize);
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
  }): Promise<StoredResult> {
    const projectInput = z
      .object({ projectId: z.string().uuid() })
      .safeParse(request.name === "select-project" ? { projectId: request.input } : request.input);
    let scope: z.infer<typeof scopeSchema> = projectInput.success
      ? { kind: "project", projectId: projectInput.data.projectId }
      : { kind: "machine" };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ kind: "pending", fingerprint, scope }));
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
      if (prior.kind === "complete") return prior;
      throw new Error(
        "This operation may have completed before the backend restarted. Check the refreshed workspace before trying again.",
      );
    }
    let response: Response;
    try {
      const data = await action();
      if (request.name === "setup-project") {
        const result = projectSetupResultSchema.parse(data);
        if (result.kind === "ready")
          scope = { kind: "project", projectId: result.snapshot.project.id };
      }
      response = { ok: true, data };
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
        await file.writeFile(JSON.stringify({ kind: "complete", fingerprint, scope, response }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await this.syncDirectory();
    } finally {
      await rm(temporary, { force: true });
    }
    return { scope, response };
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
