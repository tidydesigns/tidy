import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { z } from "zod";
import type { DesktopEvent, HarnessId, Thread } from "../shared/contracts";
import { findHarness, startHarness, type HarnessUpdate, type RunningHarness } from "./harnesses";
import { ProjectStore } from "./project-store";

type Job = {
  thread: Thread;
  process?: RunningHarness;
  stopped: boolean;
  messages: Map<string, string>;
  checkpoint?: ReturnType<typeof setTimeout>;
};

export class WorkspaceService {
  private jobs = new Map<string, Job>();
  private watchers = new Map<string, FSWatcher>();
  private listeners = new Set<(event: DesktopEvent) => void>();
  private starting = new Set<string>();
  private designGenerations = new Map<string, number>();
  private closing = false;

  constructor(
    readonly store: ProjectStore,
    private launch = startHarness,
    private locate = findHarness,
  ) {}

  subscribe(listener: (event: DesktopEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: DesktopEvent) {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  async observe(projectId: string) {
    if (this.watchers.has(projectId)) return;
    const directory = await this.store.storagePath(projectId, "designs");
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(directory, () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => {
        void this.refreshDesigns(projectId).catch(() => {});
      }, 150);
    });
    watcher.on("error", () => {
      watcher.close();
      this.watchers.delete(projectId);
    });
    this.watchers.set(projectId, watcher);
  }

  async refreshDesigns(projectId: string) {
    const generation = (this.designGenerations.get(projectId) ?? 0) + 1;
    this.designGenerations.set(projectId, generation);
    const designs = await this.store.designs(projectId);
    if (this.designGenerations.get(projectId) === generation)
      this.emit({ type: "designs", projectId, designs });
  }

  async readThread(projectId: string, threadId: string) {
    const active = this.jobs.get(threadId)?.thread;
    if (active) {
      if (active.projectId !== projectId)
        throw new Error("This thread belongs to another project.");
      return structuredClone(active);
    }
    return this.store.readThread(projectId, threadId);
  }

  async setThreadDone(projectId: string, threadId: string, done: boolean) {
    if (this.closing) throw new Error("Tidy is closing.");
    if (this.starting.has(threadId) || this.jobs.has(threadId))
      throw new Error("Wait for this run to finish before marking the thread done.");
    this.starting.add(threadId);
    try {
      const thread = await this.store.readThread(projectId, threadId);
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
    }
  }

  async startThread(input: {
    projectId: string;
    harness: HarnessId;
    prompt: string;
    designIds: string[];
  }) {
    const thread: Thread = {
      revision: 0,
      id: randomUUID(),
      projectId: input.projectId,
      harness: input.harness,
      title: input.prompt.replace(/\s+/g, " ").slice(0, 80),
      designIds: input.designIds,
      messages: [],
      status: "idle",
      updatedAt: new Date().toISOString(),
    };
    for (const designId of input.designIds) await this.store.readDesign(input.projectId, designId);
    return this.run(thread, input.prompt);
  }

  async sendMessage(input: { projectId: string; threadId: string; text: string }) {
    if (this.starting.has(input.threadId) || this.jobs.has(input.threadId))
      throw new Error("This thread is already running.");
    this.starting.add(input.threadId);
    try {
      return await this.run(
        await this.store.readThread(input.projectId, input.threadId),
        input.text,
      );
    } finally {
      this.starting.delete(input.threadId);
    }
  }

  private async run(thread: Thread, prompt: string) {
    if (this.closing) throw new Error("Tidy is closing.");
    if (thread.doneAt) throw new Error("Reopen this thread before continuing.");
    const project = this.store.project(thread.projectId);
    const executable = await this.locate(thread.harness);
    if (!executable)
      throw new Error(
        `Install ${thread.harness === "codex" ? "Codex" : "Claude Code"} and sign in with its CLI first.`,
      );
    await this.store.storagePath(project.id, "threads");
    const references = await Promise.all(
      thread.designIds.map((designId) => this.store.readDesign(project.id, designId)),
    );
    const context = [
      "You are working in a local Tidy project. The working directory is the project root.",
      "Project designs live in .tidy/designs/*.json. Each file contains { id, name, document }; document uses Tidy's shared DesignDocument schema (schemaVersion 1). Preserve this format when editing designs.",
      ...(references.length
        ? [
            "The user attached these design files (read them before implementing their UI):",
            ...references.map((design) => `${design.name}: ${design.path}`),
          ]
        : []),
      "User request:",
      prompt,
    ].join("\n\n");
    if (this.closing) throw new Error("Tidy is closing.");
    thread.messages.push({ id: randomUUID(), role: "user", text: prompt });
    thread.status = "running";
    thread.revision++;
    thread.error = undefined;
    thread.activity = "Starting";
    thread.updatedAt = new Date().toISOString();
    const job: Job = { thread, stopped: false, messages: new Map() };
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
    if (update.type === "session") {
      if (z.string().uuid().safeParse(update.id).success) thread.sessionId = update.id;
    } else if (update.type === "activity") thread.activity = update.text.slice(0, 500);
    else if (update.type === "error") thread.error = update.text.slice(0, 4000);
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
    }
    if (!job.checkpoint)
      job.checkpoint = setTimeout(() => {
        job.checkpoint = undefined;
        void this.store.writeThread(thread).catch(() => {
          thread.error = "Thread changes could not be written to disk.";
          job.process?.stop();
        });
        this.emit({ type: "thread", thread });
      }, 60);
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
    job.thread.activity = undefined;
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

  async stopThread(projectId: string, threadId: string) {
    const job = this.jobs.get(threadId);
    if (!job) return;
    if (job.thread.projectId !== projectId)
      throw new Error("This thread belongs to another project.");
    job.stopped = true;
    job.thread.activity = "Stopping";
    job.thread.revision++;
    job.process?.stop();
    this.emit({ type: "thread", thread: job.thread });
  }

  async close() {
    this.closing = true;
    for (const watcher of this.watchers.values()) watcher.close();
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
}
