import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { DesktopEvent, Thread, ProjectSnapshot } from "../../shared/contracts/desktop";
import {
  parseWorkspaceResponse,
  workspaceResponseSchemas,
  type WorkspaceOperation,
} from "../../shared/contracts/workspace-response";
import { applyProjectEvent, applyThreadPatch } from "../../shared/models/thread-updates";
import { readLocalFile } from "../platform/local-files";
import { writePrivateJSON } from "./session-store";

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const snapshotInput = z.string().uuid();
const threadInput = z
  .object({ projectId: z.string().uuid(), threadId: z.string().uuid() })
  .strict();
const cacheSchema = z.object({
  version: z.literal(1),
  hostId: z.string().uuid(),
  entries: z
    .array(
      z.discriminatedUnion("name", [
        z.object({
          name: z.literal("bootstrap"),
          input: z.undefined().optional(),
          data: workspaceResponseSchemas.bootstrap,
        }),
        z.object({
          name: z.literal("project-snapshot"),
          input: snapshotInput,
          data: workspaceResponseSchemas["project-snapshot"],
        }),
        z.object({
          name: z.literal("read-thread"),
          input: threadInput,
          data: workspaceResponseSchemas["read-thread"],
        }),
      ]),
    )
    .max(64),
});
type Entry = z.infer<typeof cacheSchema>["entries"][number];
const key = (name: string, input: unknown) => {
  if (name === "read-thread") {
    const value = threadInput.parse(input);
    return JSON.stringify([name, value.projectId, value.threadId]);
  }
  return JSON.stringify([name, input]);
};
function privateThread(thread: Thread) {
  const value = { ...thread };
  delete value.pendingApprovals;
  delete value.sessionId;
  return value;
}

export class RecoveryCache {
  readonly ready: Promise<void>;
  private values = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  private hostId: string | null;
  private closed = false;
  private epoch = 0;
  private removedAt = new Map<string, number>();
  private pendingRemovals = new Set<string>();
  private designs = new Map<
    string,
    { event: Extract<DesktopEvent, { type: "designs" }>; epoch: number }
  >();
  get revision() {
    return this.epoch;
  }
  constructor(
    private path: string | undefined,
    hostId: string | null,
  ) {
    this.hostId = hostId;
    this.ready = this.load();
  }
  private async load() {
    if (!this.path) return;
    try {
      const stored = cacheSchema.parse(
        JSON.parse((await readLocalFile(this.path, MAX_CACHE_BYTES)).toString("utf8")),
      );
      if (this.hostId && stored.hostId !== this.hostId) return;
      this.hostId = stored.hostId;
      for (const entry of stored.entries) this.values.set(key(entry.name, entry.input), entry);
    } catch {}
  }
  identify(hostId: string) {
    if (this.hostId && this.hostId !== hostId) this.values.clear();
    this.hostId = hostId;
  }
  read(name: WorkspaceOperation, input: unknown) {
    return this.values.get(key(name, input));
  }
  private mergeSnapshot(snapshot: ProjectSnapshot, startedAt: number) {
    const previous = this.read("project-snapshot", snapshot.project.id);
    const threads = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    for (const thread of previous?.name === "project-snapshot" ? previous.data.threads : []) {
      if ((threads.get(thread.id)?.revision ?? -1) < thread.revision)
        threads.set(thread.id, thread);
    }
    const latest = this.designs.get(snapshot.project.id);
    return {
      ...snapshot,
      threads: [...threads.values()],
      ...(latest && latest.epoch > startedAt
        ? { designs: latest.event.designs, folders: latest.event.folders }
        : {}),
    };
  }
  async prepareProjectRemoval(input: unknown) {
    const projectId = snapshotInput.parse(input);
    await this.ready;
    if (this.closed) throw new Error("The machine connection is closed.");
    if (this.pendingRemovals.has(projectId))
      throw new Error("This project is already being removed.");
    const previousDesign = this.designs.get(projectId);
    const previousCutoff = this.removedAt.get(projectId);
    let restored = false;
    const previous = [...this.values].filter(
      ([, entry]) =>
        entry.name === "bootstrap" ||
        (entry.name === "project-snapshot" ? entry.input : entry.input.projectId) === projectId,
    );
    this.pendingRemovals.add(projectId);
    const finish = () => {
      this.pendingRemovals.delete(projectId);
      const epoch = ++this.epoch;
      if (!restored) this.removedAt.set(projectId, epoch);
      else if (previousCutoff !== undefined) this.removedAt.set(projectId, previousCutoff);
      else this.removedAt.delete(projectId);
    };
    this.removedAt.set(projectId, ++this.epoch);
    const restore = () => {
      restored = true;
      if (previousDesign && !this.designs.has(projectId))
        this.designs.set(projectId, previousDesign);
      for (const [id, entry] of previous) {
        if (entry.name !== "bootstrap") {
          this.put(entry);
          continue;
        }
        const latest = this.values.get(id);
        const current =
          latest?.name === "bootstrap"
            ? latest.data
            : { ...entry.data, projects: [], activeProject: null };
        const project = entry.data.projects.find((item) => item.id === projectId);
        const activeProject =
          entry.data.activeProject?.project.id === projectId ? entry.data.activeProject : null;
        this.put({
          ...entry,
          data: {
            ...current,
            projects:
              project && !current.projects.some((item) => item.id === projectId)
                ? [...current.projects, project]
                : current.projects,
            activeProject: current.activeProject ?? activeProject,
          },
        });
      }
    };
    try {
      this.designs.delete(projectId);
      for (const [id, entry] of [...this.values]) {
        if (entry.name === "bootstrap") {
          this.put({
            ...entry,
            data: {
              ...entry.data,
              projects: entry.data.projects.filter((project) => project.id !== projectId),
              activeProject:
                entry.data.activeProject?.project.id === projectId
                  ? null
                  : entry.data.activeProject,
            },
          });
        } else if (
          (entry.name === "project-snapshot" ? entry.input : entry.input.projectId) === projectId
        )
          this.values.delete(id);
      }
      await this.flush({ durable: true });
      return {
        finish,
        rollback: async () => {
          restore();
          await this.flush({ durable: true });
        },
      };
    } catch (error) {
      restore();
      finish();
      throw error;
    }
  }
  capture(name: WorkspaceOperation, input: unknown, data: unknown, startedAt = this.epoch) {
    if (!this.path || this.closed) return;
    const blocked = (projectId: string) =>
      this.pendingRemovals.has(projectId) || startedAt < (this.removedAt.get(projectId) ?? -1);
    if (name === "bootstrap") {
      const response = parseWorkspaceResponse(name, { ok: true, data });
      const bootstrap = {
        ...response,
        projects: response.projects.filter((project) => !blocked(project.id)),
        activeProject:
          response.activeProject && !blocked(response.activeProject.project.id)
            ? response.activeProject
            : null,
      };
      const activeProject = bootstrap.activeProject
        ? this.mergeSnapshot(bootstrap.activeProject, startedAt)
        : null;
      this.put({ name, input: undefined, data: { ...bootstrap, activeProject } });
      if (activeProject)
        this.put({
          name: "project-snapshot",
          input: activeProject.project.id,
          data: activeProject,
        });
    } else if (
      name === "project-snapshot" ||
      name === "select-project" ||
      name === "open-project"
    ) {
      if (data) {
        const response = parseWorkspaceResponse("project-snapshot", { ok: true, data });
        if (blocked(response.project.id)) return;
        const snapshot = this.mergeSnapshot(response, startedAt);
        this.put({ name: "project-snapshot", input: snapshot.project.id, data: snapshot });
      }
    } else if (
      [
        "read-thread",
        "start-thread",
        "send-message",
        "thread-settings",
        "thread-execution-project",
        "set-thread-done",
        "respond-approval",
      ].includes(name)
    ) {
      const thread = parseWorkspaceResponse("read-thread", { ok: true, data });
      if (blocked(thread.projectId)) return;
      const previous = this.read("read-thread", {
        projectId: thread.projectId,
        threadId: thread.id,
      });
      if (previous?.name === "read-thread" && previous.data.revision > thread.revision) return;
      this.put({
        name: "read-thread",
        input: { projectId: thread.projectId, threadId: thread.id },
        data: privateThread(thread),
      });
    }
  }
  receive(event: DesktopEvent) {
    if (!this.path || this.closed) return;
    this.epoch++;
    if (event.type === "designs") {
      this.designs.delete(event.projectId);
      this.designs.set(event.projectId, { event, epoch: this.epoch });
      if (this.designs.size > 100) {
        const oldest = this.designs.keys().next();
        if (!oldest.done) this.designs.delete(oldest.value);
      }
    }
    const entries = [...this.values.values()];
    for (const entry of entries) {
      if (entry.name === "project-snapshot") {
        const snapshot = entry.data;
        if (
          (event.type === "designs" ? event.projectId : event.thread.projectId) ===
          snapshot.project.id
        )
          this.put({ ...entry, data: applyProjectEvent(snapshot, event) });
      } else if (entry.name === "bootstrap") {
        const bootstrap = entry.data;
        if (
          bootstrap.activeProject &&
          (event.type === "designs" ? event.projectId : event.thread.projectId) ===
            bootstrap.activeProject.project.id
        )
          this.put({
            ...entry,
            data: {
              ...bootstrap,
              activeProject: applyProjectEvent(bootstrap.activeProject, event),
            },
          });
      } else if (event.type === "thread" || event.type === "thread-patch") {
        const previous = entry.data;
        if (
          event.thread.id === previous.id &&
          event.thread.projectId === previous.projectId &&
          event.thread.revision >= previous.revision
        )
          this.put({
            ...entry,
            data: privateThread(
              event.type === "thread" ? event.thread : applyThreadPatch(previous, event),
            ),
          });
      }
    }
  }
  private put(entry: Entry) {
    if (this.closed) return;
    const id = key(entry.name, entry.input);
    this.values.delete(id);
    this.values.set(id, entry);
    while (this.values.size > 64) {
      const oldest =
        [...this.values].find(([, entry]) => entry.name !== "bootstrap")?.[0] ??
        this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    if (this.path && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => {});
      }, 1000);
  }
  close() {
    this.closed = true;
    return this.flush();
  }
  async flush({ durable = false }: { durable?: boolean } = {}) {
    await this.ready;
    clearTimeout(this.timer);
    this.timer = undefined;
    const path = this.path;
    if (!path || !this.hostId) return;
    let total = 1024;
    const sizes = new Map<string, number>();
    for (const [id, entry] of this.values) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (size > MAX_CACHE_BYTES - 1024) this.values.delete(id);
      else {
        total += size;
        sizes.set(id, size);
      }
    }
    while (total > MAX_CACHE_BYTES && this.values.size) {
      const id =
        [...this.values].find(([, entry]) => entry.name !== "bootstrap")?.[0] ??
        this.values.keys().next().value;
      if (id === undefined) break;
      total -= sizes.get(id) ?? 0;
      this.values.delete(id);
    }
    const snapshot = { version: 1, hostId: this.hostId, entries: [...this.values.values()] };
    const write = this.writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writePrivateJSON(path, snapshot, { durable });
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
