import { summarizeThread } from "../shared/thread-updates";
import {
  approvalDecisionSchema,
  validatePermissionMode,
  type ApprovalDecision,
} from "../shared/permissions";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { z } from "zod";
import type { DesktopEvent, HarnessId, Thread, ThreadSummary } from "../shared/contracts";
import { findHarness, startHarness, type HarnessUpdate, type RunningHarness } from "./harnesses";
import {
  attachmentSchema,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_IMAGE_BYTES,
} from "../shared/attachments";
import { validateHarnessSettings } from "./harness-details";
import { harnessSettingsSchema, type HarnessSettings } from "../shared/harness-settings";
import {
  toolActivitySchema,
  toolLogSize,
  MAX_TOOL_ACTIVITIES,
  MAX_TOOL_LOG_CHARACTERS,
} from "../shared/tool-activity";
import { ProjectStore } from "./project-store";
import { readLocalFile } from "./local-files";

type Job = {
  thread: Thread;
  process?: RunningHarness;
  stopped: boolean;
  messages: Map<string, string>;
  tools: Map<string, string>;
  changedMessages: Set<string>;
  changedTools: Set<string>;
  usageBase?: Thread["usage"];
  checkpoint?: ReturnType<typeof setTimeout>;
  notification?: ReturnType<typeof setTimeout>;
};

export class WorkspaceService {
  private jobs = new Map<string, Job>();
  private watchers = new Map<string, FSWatcher>();
  private listeners = new Set<(event: DesktopEvent) => void>();
  private starting = new Map<string, string>();
  private cancelledStarts = new Set<string>();
  private designGenerations = new Map<string, number>();
  private closing: symbol | "quit" | undefined;

  constructor(
    readonly store: ProjectStore,
    private launch = startHarness,
    private locate = findHarness,
    private configure = validateHarnessSettings,
  ) {}

  subscribe(listener: (event: DesktopEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: DesktopEvent) {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  withLiveThreads(projectId: string, threads: ThreadSummary[]) {
    return threads.map((summary) => {
      const active = this.jobs.get(summary.id)?.thread;
      return active?.projectId === projectId ? summarizeThread(active) : summary;
    });
  }

  async observe(projectId: string) {
    if (this.watchers.has(projectId)) return;
    const directories = await Promise.all(
      (["designs", "folders"] as const).map((kind) => this.store.storagePath(projectId, kind)),
    );
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const watchers = directories.map((directory) =>
      watch(directory, () => {
        clearTimeout(refresh);
        refresh = setTimeout(() => {
          void this.refreshDesigns(projectId).catch(() => {});
        }, 150);
      }),
    );
    watchers.forEach((watcher, index) => {
      const key = index === 0 ? projectId : `${projectId}:folders`;
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(key);
      });
      this.watchers.set(key, watcher);
    });
  }

  async refreshDesigns(projectId: string) {
    const generation = (this.designGenerations.get(projectId) ?? 0) + 1;
    this.designGenerations.set(projectId, generation);
    const [designs, folders] = await Promise.all([
      this.store.designs(projectId),
      this.store.folders(projectId),
    ]);
    if (this.designGenerations.get(projectId) === generation)
      this.emit({ type: "designs", projectId, designs, folders });
  }

  async readThread(projectId: string, threadId: string): Promise<Thread> {
    const active = this.jobs.get(threadId)?.thread;
    if (active) {
      if (active.projectId !== projectId)
        throw new Error("This thread belongs to another project.");
      return structuredClone(active);
    }
    return this.store.readThread(projectId, threadId);
  }

  /** Mark a finished thread done/reopened without admitting delayed writes during shutdown. */
  async setThreadDone(projectId: string, threadId: string, done: boolean) {
    if (this.closing) throw new Error("Tidy is closing.");
    if (this.starting.has(threadId) || this.jobs.has(threadId))
      throw new Error("Wait for this run to finish before marking the thread done.");
    this.starting.set(threadId, projectId);
    try {
      const thread = await this.store.readThread(projectId, threadId);
      if (this.closing) throw new Error("Tidy is closing.");
      if (thread.status === "running")
        throw new Error("Wait for this run to finish before marking the thread done.");
      if (Boolean(thread.doneAt) === done) return thread;
      thread.doneAt = done ? new Date().toISOString() : undefined;
      thread.revision++;
      await this.store.writeThread(thread);
      this.emit({ type: "thread", thread });
      return thread;
    } finally {
      this.starting.delete(threadId);
      this.cancelledStarts.delete(threadId);
    }
  }

  /** Validate settings and reject delayed requests once shutdown begins. */
  async setThreadSettings(projectId: string, threadId: string, settings: HarnessSettings) {
    if (this.closing) throw new Error("Tidy is closing.");
    if (this.starting.has(threadId) || this.jobs.has(threadId))
      throw new Error("Wait for this run to finish before changing its settings.");
    this.starting.set(threadId, projectId);
    try {
      const thread = await this.store.readThread(projectId, threadId);
      if (this.closing) throw new Error("Tidy is closing.");
      await this.configure(thread.harness, this.store.project(projectId).path, settings);
      if (this.closing) throw new Error("Tidy is closing.");
      thread.settings = settings;
      thread.revision++;
      await this.store.writeThread(thread);
      this.emit({ type: "thread", thread });
      return thread;
    } finally {
      this.starting.delete(threadId);
      this.cancelledStarts.delete(threadId);
    }
  }

  async startThread(input: {
    threadId?: string;
    messageId?: string;
    projectId: string;
    harness: HarnessId;
    prompt: string;
    designIds: string[];
    settings?: HarnessSettings;
    attachmentIds?: string[];
  }) {
    const thread: Thread = {
      revision: 0,
      id: input.threadId ?? randomUUID(),
      projectId: input.projectId,
      harness: input.harness,
      settings: input.settings,
      title: input.prompt.replace(/\s+/g, " ").slice(0, 80),
      designIds: input.designIds,
      messages: [],
      status: "idle",
      updatedAt: new Date().toISOString(),
    };
    if (this.starting.has(thread.id) || this.jobs.has(thread.id))
      throw new Error("This thread is already running.");
    this.starting.set(thread.id, input.projectId);
    try {
      if (input.threadId && (await this.store.threadExists(input.projectId, input.threadId)))
        throw new Error("This thread already exists.");
      return await this.run(thread, input.prompt, input.attachmentIds, input.messageId);
    } finally {
      this.starting.delete(thread.id);
      this.cancelledStarts.delete(thread.id);
    }
  }

  async sendMessage(input: {
    messageId?: string;
    projectId: string;
    threadId: string;
    text: string;
    attachmentIds?: string[];
  }) {
    if (this.starting.has(input.threadId) || this.jobs.has(input.threadId))
      throw new Error("This thread is already running.");
    this.starting.set(input.threadId, input.projectId);
    try {
      return await this.run(
        await this.store.readThread(input.projectId, input.threadId),
        input.text,
        input.attachmentIds,
        input.messageId,
      );
    } finally {
      this.starting.delete(input.threadId);
      this.cancelledStarts.delete(input.threadId);
    }
  }

  private async run(
    thread: Thread,
    prompt: string,
    attachmentIds: string[] = [],
    messageId?: string,
  ) {
    if (this.closing) throw new Error("Tidy is closing.");
    if (thread.doneAt) throw new Error("Reopen this thread before continuing.");
    const project = this.store.project(thread.projectId);
    if (messageId && thread.messages.some((message) => message.id === messageId))
      throw new Error("This message was already sent.");
    const settings = harnessSettingsSchema.parse(thread.settings ?? {});
    validatePermissionMode(thread.harness, settings.permissionMode);
    z.array(z.string().uuid()).max(MAX_ATTACHMENTS).parse(attachmentIds);
    if (!prompt.trim() && !attachmentIds.length)
      throw new Error("Write a message or attach a file.");
    const attachments = await Promise.all(
      [...new Set(attachmentIds)].map((id) => this.store.resolveAttachment(project.id, id)),
    );
    if (attachments.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES)
      throw new Error("Keep attachments under 25 MB per message.");
    const imagesPromise = Promise.all(
      attachments
        .filter((file) =>
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimeType),
        )
        .map(async (file) => ({
          path: file.path,
          mimeType: file.mimeType,
          data: (await readLocalFile(file.path, MAX_IMAGE_BYTES)).toString("base64"),
        })),
    );
    if (!thread.title) thread.title = attachments[0]?.name.slice(0, 80) ?? "New thread";
    // Model and effort are already chosen from the catalog. The native harness validates
    // them at launch; sending must never fetch account limits or refresh that catalog.
    const [executable, references, images] = await Promise.all([
      this.locate(thread.harness),
      Promise.all(
        thread.designIds.map((designId) => this.store.readDesign(project.id, designId, false)),
      ),
      imagesPromise,
    ]);
    if (!executable)
      throw new Error(
        `Install ${thread.harness === "codex" ? "Codex" : "Claude Code"} and sign in with its CLI first.`,
      );
    const context = [
      "You are working in a local Tidy project. The working directory is the project root.",
      "Project designs live in .tidy/designs/*.json. Each file contains { id, name, folderId, document }; folderId is a local design-folder ID or null. Preserve id, name and folderId when editing document content. Folder metadata lives in .tidy/folders/<id>.json and design paths remain stable when files move between folders. document uses Tidy's shared DesignDocument schema (schemaVersion 1). Preserve this format when editing designs.",
      ...(references.length
        ? [
            "The user attached these design files (read them before implementing their UI):",
            ...references.map((design) => `${design.name}: ${design.path}`),
          ]
        : []),
      ...(attachments.length
        ? [
            "The user attached these local files. Image attachments are also included as image input; read other files with your file tools as needed:",
            ...attachments.map((file) => `${JSON.stringify(file.name)}: ${file.path}`),
          ]
        : []),
      "User request:",
      prompt || "Review the attached files.",
    ].join("\n\n");
    if (this.closing) throw new Error("Tidy is closing.");
    thread.messages.push({
      id: messageId ?? randomUUID(),
      role: "user",
      text: prompt,
      ...(attachments.length
        ? { attachments: attachments.map((file) => attachmentSchema.parse(file)) }
        : {}),
    });
    thread.status = "running";
    thread.revision++;
    thread.error = undefined;
    thread.activity = "Starting";
    thread.updatedAt = new Date().toISOString();
    const job: Job = {
      thread,
      stopped: this.cancelledStarts.has(thread.id),
      messages: new Map(),
      tools: new Map(),
      changedMessages: new Set(),
      changedTools: new Set(),
      usageBase: thread.usage ? { ...thread.usage } : undefined,
    };
    this.jobs.set(thread.id, job);
    try {
      await this.store.writeThread(thread);
    } catch (error) {
      this.jobs.delete(thread.id);
      throw error;
    }
    this.emit({ type: "thread", thread });
    if (job.stopped || this.closing) {
      thread.status = "stopped";
      thread.activity = undefined;
      thread.revision++;
      this.jobs.delete(thread.id);
      await this.store.writeThread(thread);
      this.emit({ type: "thread", thread });
      return structuredClone(thread);
    }
    try {
      job.process = this.launch({
        harness: thread.harness,
        executable,
        cwd: project.path,
        prompt: context,
        sessionId: thread.sessionId,
        settings: thread.settings,
        images,
        onUpdate: (update) => this.update(job, update),
      });
      if (job.stopped) job.process.stop();
      void this.complete(job);
    } catch (error) {
      thread.status = "failed";
      thread.error = error instanceof Error ? error.message : "The harness could not start.";
      this.jobs.delete(thread.id);
      await this.store.writeThread(thread);
      this.emit({ type: "thread", thread });
    }
    return structuredClone(thread);
  }

  private update(job: Job, update: HarnessUpdate) {
    if (job.stopped) return;
    const thread = job.thread;
    thread.revision++;
    if (update.type === "approval") {
      thread.pendingApprovals = [
        ...(thread.pendingApprovals ?? []).filter((request) => request.id !== update.request.id),
        update.request,
      ];
      thread.activity = "Needs permission";
      this.emit({ type: "thread", thread });
      return;
    } else if (update.type === "approval-resolved") {
      thread.pendingApprovals = thread.pendingApprovals?.filter(
        (request) => request.id !== update.id,
      );
      thread.activity = thread.pendingApprovals?.length ? "Needs permission" : "Working";
      this.emit({ type: "thread", thread });
      return;
    } else if (update.type === "tool") {
      const activities = thread.toolActivities ?? (thread.toolActivities = []);
      const existing = activities.find((tool) => tool.id === job.tools.get(update.tool.id));
      const now = new Date().toISOString();
      const value = toolActivitySchema.parse({
        ...existing,
        ...update.tool,
        id: existing?.id ?? randomUUID(),
        afterMessageId: existing?.afterMessageId ?? thread.messages.at(-1)!.id,
        startedAt: existing?.startedAt ?? now,
        endedAt: update.tool.status === "running" ? undefined : (existing?.endedAt ?? now),
      });
      if (existing) Object.assign(existing, value);
      else {
        activities.push(value);
        job.tools.set(update.tool.id, value.id);
      }
      job.changedTools.add(value.id);
      let size = activities.reduce((total, tool) => total + toolLogSize(tool), 0);
      while (activities.length > MAX_TOOL_ACTIVITIES || size > MAX_TOOL_LOG_CHARACTERS) {
        size -= toolLogSize(activities.shift()!);
        thread.toolActivityTruncated = true;
      }
      thread.activity = value.status === "running" ? value.title : undefined;
    } else if (update.type === "usage") {
      const base = update.cumulative ? undefined : job.usageBase;
      thread.usage = {
        inputTokens: (base?.inputTokens ?? 0) + update.usage.inputTokens,
        outputTokens: (base?.outputTokens ?? 0) + update.usage.outputTokens,
        cachedInputTokens: (base?.cachedInputTokens ?? 0) + update.usage.cachedInputTokens,
        costUSD: update.usage.costUSD ?? base?.costUSD,
      };
    } else if (update.type === "model") thread.actualModel = update.model.slice(0, 200);
    else if (update.type === "session") {
      if (z.string().uuid().safeParse(update.id).success) thread.sessionId = update.id;
    } else if (update.type === "error") thread.error = update.text.slice(0, 4000);
    else {
      let message = thread.messages.find((item) => item.id === job.messages.get(update.id));
      if (!message) {
        if (thread.messages.length >= 998) {
          job.thread.error = "The thread reached its message limit.";
          job.process?.stop();
          return;
        }
        message = { id: randomUUID(), role: "assistant", text: "" };
        thread.messages.push(message);
        job.messages.set(update.id, message.id);
      }
      message.text = (update.append ? message.text + update.text : update.text).slice(0, 1_000_000);
      job.changedMessages.add(message.id);
    }
    // Painting and persistence are independent: stream promptly without serializing
    // and writing the complete transcript on every UI update.
    if (!job.notification)
      job.notification = setTimeout(() => {
        job.notification = undefined;
        const { messages, toolActivities, ...metadata } = thread;
        this.emit({
          type: "thread-patch",
          thread: metadata,
          summary: summarizeThread(thread),
          messages: messages.filter((message) => job.changedMessages.has(message.id)),
          toolActivities: (toolActivities ?? []).filter((tool) => job.changedTools.has(tool.id)),
          toolActivityIds: (toolActivities ?? []).map((tool) => tool.id),
        });
        job.changedMessages.clear();
        job.changedTools.clear();
      }, 32);
    if (!job.checkpoint)
      job.checkpoint = setTimeout(() => {
        job.checkpoint = undefined;
        void this.store.writeThread(thread).catch(() => {
          thread.error = "Thread changes could not be written to disk.";
          job.process?.stop();
        });
      }, 250);
  }

  private async complete(job: Job) {
    try {
      await job.process!.done;
      job.thread.status = job.stopped ? "stopped" : job.thread.error ? "failed" : "completed";
    } catch (error) {
      job.thread.status = job.stopped ? "stopped" : "failed";
      if (!job.stopped)
        job.thread.error =
          error instanceof Error ? error.message : "The harness stopped unexpectedly.";
    }
    clearTimeout(job.checkpoint);
    clearTimeout(job.notification);
    const ownedTools = new Set(job.tools.values());
    for (const tool of job.thread.toolActivities ?? [])
      if (tool.status === "running" && ownedTools.has(tool.id)) {
        tool.status = job.stopped ? "cancelled" : "interrupted";
        tool.endedAt = new Date().toISOString();
      }
    job.thread.activity = undefined;
    job.thread.pendingApprovals = undefined;
    job.thread.revision++;
    job.thread.updatedAt = new Date().toISOString();
    try {
      await this.store.writeThread(job.thread);
    } catch {
      job.thread.error = "Thread changes could not be written to disk.";
    }
    this.jobs.delete(job.thread.id);
    this.emit({ type: "thread", thread: job.thread });
    await this.refreshDesigns(job.thread.projectId).catch(() => {});
  }

  async respondToApproval(
    projectId: string,
    threadId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) {
    approvalDecisionSchema.parse(decision);
    const job = this.jobs.get(threadId);
    if (!job || job.stopped || this.closing)
      throw new Error("This permission request is no longer active.");
    if (job.thread.projectId !== projectId)
      throw new Error("This thread belongs to another project.");
    const request = job.thread.pendingApprovals?.find((request) => request.id === approvalId);
    if (!request || !request.choices.includes(decision))
      throw new Error("This permission response is no longer available.");
    if (!job.process?.respondToApproval?.(approvalId, decision))
      throw new Error("This permission request is no longer active.");
    job.thread.pendingApprovals = job.thread.pendingApprovals?.filter(
      (request) => request.id !== approvalId,
    );
    job.thread.revision++;
    this.emit({ type: "thread", thread: job.thread });
    return structuredClone(job.thread);
  }

  async stopThread(projectId: string, threadId: string) {
    const job = this.jobs.get(threadId);
    if (!job) {
      const preparingProject = this.starting.get(threadId);
      if (preparingProject && preparingProject !== projectId)
        throw new Error("This thread belongs to another project.");
      if (preparingProject) this.cancelledStarts.add(threadId);
      return;
    }
    if (job.thread.projectId !== projectId)
      throw new Error("This thread belongs to another project.");
    job.stopped = true;
    job.thread.activity = "Stopping";
    job.thread.pendingApprovals = undefined;
    job.thread.revision++;
    job.process?.stop();
    this.emit({ type: "thread", thread: job.thread });
  }

  /** Persist harness work; recovery releases only this update's shutdown reservation. */
  async prepareUpdate() {
    if (this.closing) throw new Error("Tidy is closing.");
    const update = Symbol("update");
    this.closing = update;
    try {
      await this.stopAndFlush();
    } catch (error) {
      if (this.closing === update) this.closing = undefined;
      throw error;
    }
    return () => {
      // An ordinary quit or a later preparation owns its own shutdown reservation.
      if (this.closing === update) this.closing = undefined;
    };
  }

  private async stopAndFlush() {
    for (const job of this.jobs.values()) {
      job.stopped = true;
      job.process?.stop();
    }
    await Promise.all([...this.jobs.values()].map((job) => job.process?.done.catch(() => {})));
    // Final checkpoints are queued after child termination.
    for (const job of this.jobs.values())
      await this.store.writeThread({ ...job.thread, status: "interrupted", activity: undefined });
    await this.store.flush();
  }

  async close() {
    this.closing = "quit";
    for (const watcher of this.watchers.values()) watcher.close();
    await this.stopAndFlush();
  }
}
