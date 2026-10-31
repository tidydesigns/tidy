import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { harnessIdSchema, type Thread } from "../../shared/contracts/desktop";
import { permissionModeSchema } from "../../shared/contracts/permissions";
import { harnessSettingsSchema } from "../../shared/contracts/harness-settings";
import { taskStoreWorker } from "./task-store-worker";
import { taskStateSchema, threadTasksPageSchema } from "../../shared/contracts/thread-tasks";
export { taskStateSchema } from "../../shared/contracts/thread-tasks";

const uuid = z.string().uuid();
const receiptKey = z.string().regex(/^canvas-[a-f0-9]{64}$/);
export const taskInputSchema = z
  .object({
    projectId: uuid,
    parentThreadId: uuid,
    childThreadId: uuid,
    requestId: uuid,
    prompt: z.string().trim().min(1).max(16_000),
    kind: z.enum(["initial", "followup", "message"]).optional(),
    originatingMessageId: uuid.optional(),
    recipientGrant: uuid.optional(),
    parentGrant: z
      .object({ harness: harnessIdSchema, permissionMode: permissionModeSchema })
      .strict()
      .optional(),
    harness: harnessIdSchema,
    settings: harnessSettingsSchema,
    designIds: z.array(uuid).max(100),
    depth: z.number().int().min(0).max(8),
  })
  .strict();
export const taskRecordSchema = taskInputSchema.extend({
  id: uuid,
  state: taskStateSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  summary: z.string().max(16_000).optional(),
  error: z.string().max(16_000).optional(),
  delivered: z.boolean(),
  deliveryError: z.string().max(2000).optional(),
  archived: z.literal(true).optional(),
  promptHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
const transitionSchema = z
  .object({
    id: uuid,
    state: taskStateSchema,
    summary: z.string().max(16_000).optional(),
    error: z.string().max(16_000).optional(),
  })
  .strict();
const listSchema = z
  .object({
    projectId: uuid,
    parentThreadId: uuid,
    ids: z.array(uuid).max(100).optional(),
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int(), ok: z.literal(true), value: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
  }),
]);
export class TaskStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskStoreError";
  }
}
export class TaskStore {
  private worker?: Worker;
  private parents = new Map<string, string>();
  private receivers = new Map<string, { grantId: string; projectScope?: string }>();
  private initialization?: Promise<void>;
  private closing = false;
  private shutdown?: Promise<void>;
  private initializedOnce = false;
  private retryAt = 0;
  private failures = 0;
  private workerStartedAt = 0;
  private retirements = new Set<Promise<unknown>>();
  private next = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  constructor(
    private directory: string,
    private onChange?: (task: TaskRecord) => void,
    private projectScope?: (projectId: string) => string | undefined,
  ) {}

  initialize() {
    if (this.closing)
      return Promise.reject(new TaskStoreError("CLOSED", "Assignment storage is closed."));
    if (this.initialization) return this.initialization;
    if (Date.now() < this.retryAt)
      return Promise.reject(
        new TaskStoreError(
          "BUSY",
          "Assignment storage is recovering. Retry shortly with the same request ID.",
        ),
      );
    const initialization = this.start().catch((error: unknown) => {
      if (this.initialization === initialization) {
        this.initialization = undefined;
        if (this.retryAt <= Date.now()) this.deferRecovery();
      }
      throw error;
    });
    this.initialization = initialization;
    return initialization;
  }
  private deferRecovery() {
    this.failures++;
    this.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
  }
  private retire(worker: Worker) {
    const retirement = worker
      .terminate()
      .catch(() => {})
      .finally(() => this.retirements.delete(retirement));
    this.retirements.add(retirement);
    return retirement;
  }
  private async start() {
    if (this.closing) throw new TaskStoreError("CLOSED", "Assignment storage is closed.");
    await Promise.allSettled(this.retirements);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new TaskStoreError("STORAGE", "Invalid assignment storage directory.");
    await chmod(this.directory, 0o700);
    const path = join(this.directory, "tasks.sqlite");
    const file = await open(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new TaskStoreError("STORAGE", "Invalid assignment database.");
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    if (this.closing) throw new TaskStoreError("CLOSED", "Assignment storage is closed.");
    const worker = new Worker(taskStoreWorker, {
      eval: true,
      execArgv: [],
      workerData: { path },
    });
    this.worker = worker;
    this.workerStartedAt = Date.now();
    worker.on("message", (value: unknown) => {
      if (this.worker !== worker) return;
      const result = responseSchema.safeParse(value);
      if (!result.success)
        return this.failed(
          worker,
          new TaskStoreError("STORAGE", "Invalid assignment storage response."),
        );
      const response = result.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new TaskStoreError(response.code, response.message));
      if (!this.pending.size) worker.unref();
    });
    worker.on("error", () =>
      this.failed(
        worker,
        new TaskStoreError(
          "STORAGE",
          "Assignment storage stopped. Its last operation may have committed; retry with the same request ID.",
        ),
      ),
    );
    worker.on("exit", () =>
      this.failed(
        worker,
        new TaskStoreError(
          "STORAGE",
          "Assignment storage stopped. Its last operation may have committed; retry with the same request ID.",
        ),
        false,
      ),
    );
    try {
      const initialized = z
        .object({
          lineage: z
            .array(z.object({ projectId: uuid, childThreadId: uuid, parentThreadId: uuid }))
            .max(110_000),
          receivers: z
            .array(
              z.object({
                projectId: uuid,
                threadId: uuid,
                grantId: uuid,
                projectScope: z.string().nullable().optional(),
              }),
            )
            .max(10_000),
        })
        .parse(await this.call("initialize", { recover: !this.initializedOnce }));
      this.parents.clear();
      this.receivers.clear();
      for (const item of initialized.lineage)
        this.parents.set(`${item.projectId}:${item.childThreadId}`, item.parentThreadId);
      for (const item of initialized.receivers)
        this.receivers.set(`${item.projectId}:${item.threadId}`, {
          grantId: item.grantId,
          ...(item.projectScope ? { projectScope: item.projectScope } : {}),
        });
      this.initializedOnce = true;
    } catch (error) {
      if (this.worker === worker)
        this.failed(
          worker,
          error instanceof Error
            ? error
            : new TaskStoreError("STORAGE", "Assignment storage could not initialize."),
        );
      await Promise.allSettled(this.retirements);
      throw error;
    }
  }
  private failed(worker: Worker, error: Error, terminate = true) {
    if (this.worker !== worker) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker = undefined;
    this.initialization = undefined;
    this.receivers.clear();
    if (!this.closing) {
      if (Date.now() - this.workerStartedAt >= 30_000) this.failures = 0;
      this.deferRecovery();
    }
    if (terminate) void this.retire(worker);
  }
  private call(kind: string, input: unknown): Promise<unknown> {
    const worker = this.worker;
    if (!worker)
      return Promise.reject(new TaskStoreError("CLOSED", "Assignment storage is unavailable."));
    if (this.pending.size >= 64)
      return Promise.reject(
        new TaskStoreError("BUSY", "Assignment storage is busy. Retry shortly."),
      );
    const id = ++this.next;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, kind, input });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        if (!this.pending.size) worker.unref();
      }
    });
  }
  private async ready() {
    await this.initialize();
    if (this.closing) throw new TaskStoreError("CLOSED", "Assignment storage is closed.");
  }
  async create(input: TaskInput): Promise<TaskRecord> {
    const parsed = taskInputSchema.parse(input);
    await this.ready();
    const fingerprint = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const task = taskRecordSchema.parse(await this.call("create", { ...parsed, fingerprint }));
    if (task.kind !== "message")
      this.parents.set(`${task.projectId}:${task.childThreadId}`, task.parentThreadId);
    this.onChange?.(task);
    return task;
  }
  async list(input: z.input<typeof listSchema>) {
    const parsed = listSchema.parse(input);
    await this.ready();
    return z
      .object({
        tasks: z.array(taskRecordSchema).max(100),
        cursor: z.number().int().nonnegative(),
      })
      .parse(await this.call("list", parsed));
  }
  async get(id: string): Promise<TaskRecord | undefined> {
    uuid.parse(id);
    await this.ready();
    const result = await this.call("get", { id });
    return result === null ? undefined : taskRecordSchema.parse(result);
  }
  async forRequest(
    projectId: string,
    parentThreadId: string,
    requestId: string,
  ): Promise<TaskRecord | undefined> {
    uuid.parse(projectId);
    uuid.parse(parentThreadId);
    uuid.parse(requestId);
    await this.ready();
    const result = await this.call("for-request", { projectId, parentThreadId, requestId });
    return result === null ? undefined : taskRecordSchema.parse(result);
  }
  receiverGrant(projectId: string, threadId: string) {
    if (this.closing) return undefined;
    const entry = this.receivers.get(`${projectId}:${threadId}`);
    if (!entry) return undefined;
    if (this.projectScope) {
      const current = this.projectScope(projectId);
      if (!current || current !== entry.projectScope) return undefined;
    }
    return entry.grantId;
  }
  async setReceiver(projectId: string, threadId: string, enabled: boolean) {
    uuid.parse(projectId);
    uuid.parse(threadId);
    z.boolean().parse(enabled);
    await this.ready();
    const projectScope = this.projectScope?.(projectId);
    if (enabled && this.projectScope && !projectScope)
      throw new TaskStoreError(
        "NOT_FOUND",
        "Register this project before enabling incoming agent messages.",
      );
    const grant = uuid
      .nullable()
      .parse(await this.call("set-receiver", { projectId, threadId, enabled, projectScope }));
    const key = `${projectId}:${threadId}`;
    if (grant)
      this.receivers.set(key, { grantId: grant, ...(projectScope ? { projectScope } : {}) });
    else this.receivers.delete(key);
  }
  parentThreadId(projectId: string, childThreadId: string) {
    return this.parents.get(`${projectId}:${childThreadId}`);
  }
  async forChild(projectId: string, childThreadId: string): Promise<TaskRecord | undefined> {
    uuid.parse(projectId);
    uuid.parse(childThreadId);
    await this.ready();
    const result = await this.call("for-child", { projectId, childThreadId });
    return result === null ? undefined : taskRecordSchema.parse(result);
  }
  async transition(input: z.input<typeof transitionSchema>): Promise<TaskRecord> {
    const parsed = transitionSchema.parse(input);
    await this.ready();
    const task = taskRecordSchema.parse(await this.call("transition", parsed));
    this.onChange?.(task);
    return task;
  }
  async threadPage(projectId: string, parentThreadId: string, before?: number, taskIds?: string[]) {
    uuid.parse(projectId);
    uuid.parse(parentThreadId);
    if (before !== undefined) z.number().int().positive().parse(before);
    if (taskIds) z.array(uuid).min(1).max(50).parse(taskIds);
    await this.ready();
    return threadTasksPageSchema.parse(
      await this.call("thread-page", { projectId, parentThreadId, before, taskIds }),
    );
  }
  async pendingDeliveries(after = 0): Promise<TaskRecord[]> {
    z.number().int().nonnegative().parse(after);
    await this.ready();
    return z
      .array(taskRecordSchema)
      .max(100)
      .parse(await this.call("pending", { after }));
  }
  async incomingSources(
    projectId: string,
    threadId: string,
    messages: Pick<Thread["messages"][number], "id" | "text" | "role" | "attachments">[],
  ) {
    uuid.parse(projectId);
    uuid.parse(threadId);
    if (messages.length > 1000)
      throw new TaskStoreError(
        "CAPACITY",
        "Incoming message attribution is limited to 1,000 messages.",
      );
    const candidates = messages.flatMap((message) =>
      message.role === "user" && !message.attachments?.length && uuid.safeParse(message.id).success
        ? [
            {
              messageId: message.id,
              textHash: createHash("sha256").update(message.text).digest("hex"),
            },
          ]
        : [],
    );
    if (!candidates.length) return [];
    await this.ready();
    return z
      .array(z.object({ messageId: uuid, threadId: uuid }).strict())
      .max(1000)
      .parse(await this.call("incoming-sources", { projectId, threadId, candidates }));
  }
  async maintain(input: { before?: string } = {}) {
    const parsed = z.object({ before: z.string().datetime().optional() }).strict().parse(input);
    await this.ready();
    return z
      .object({
        compactedTasks: z.number().int().nonnegative().max(100),
        expiredReceipts: z.number().int().nonnegative().max(100),
        capacityReached: z.boolean(),
        hasMore: z.boolean(),
      })
      .strict()
      .parse(await this.call("maintain", parsed));
  }
  async readReceipt(key: string): Promise<unknown | undefined> {
    receiptKey.parse(key);
    await this.ready();
    const result = z
      .discriminatedUnion("found", [
        z.object({ found: z.literal(false) }),
        z.object({ found: z.literal(true), value: z.json() }),
      ])
      .parse(await this.call("read-receipt", { key }));
    return result.found ? result.value : undefined;
  }
  async writeReceipt(key: string, value: unknown): Promise<void> {
    receiptKey.parse(key);
    const encoded = JSON.stringify(z.json().parse(value));
    if (Buffer.byteLength(encoded) > 64 * 1024)
      throw new TaskStoreError("CAPACITY", "The operation receipt exceeds its size limit.");
    await this.ready();
    await this.call("write-receipt", { key, encoded });
  }
  async deliveryFailed(id: string, message: string) {
    uuid.parse(id);
    z.string().max(2000).parse(message);
    await this.ready();
    await this.call("delivery-failed", { id, message });
  }
  async delivered(id: string) {
    uuid.parse(id);
    await this.ready();
    await this.call("delivered", { id });
  }
  close() {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      await this.initialization?.catch(() => {});
      const worker = this.worker;
      try {
        if (worker) await this.call("close", {});
      } finally {
        if (this.worker === worker) this.worker = undefined;
        if (worker) await this.retire(worker);
        await Promise.allSettled(this.retirements);
      }
    })();
    return this.shutdown;
  }
}
