import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  blankDesignDocument,
  designDocumentSchema,
  documentAssetIds,
  type DesignDocument,
} from "@tidy/design/document";
import { documentPatchSchema } from "@tidy/editor/design/document-patch";
import type { CloudState } from "../shared/cloud-sync";
import type { LocalDesign } from "../shared/contracts";
import type { CloudRemote, CloudSnapshot } from "./cloud-remote";
import { CloudHTTPError } from "./cloud-auth";
import { PrivateState } from "./private-state";
import { ProjectStore } from "./project-store";
import { CloudCompute } from "./cloud-compute";

const snapshotSchema = z.object({
  name: z.string().optional(),
  revision: z.number().int().nonnegative(),
  content: designDocumentSchema,
});
const bindingSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectPath: z.string(),
  designId: z.uuid(),
  fileId: z.uuid(),
  organizationId: z.string().optional(),
  name: z.string().optional(),
  origin: z.string(),
  pendingName: z.object({ before: z.string(), name: z.string() }).optional(),
  accountId: z.string(),
  base: snapshotSchema,
  aliases: z.record(z.string(), z.string()),
  creating: z.object({ organizationId: z.string(), name: z.string() }).optional(),
  pending: z
    .object({
      operationId: z.uuid(),
      base: snapshotSchema,
      patch: documentPatchSchema,
      local: designDocumentSchema,
    })
    .optional(),
  conflict: snapshotSchema.optional(),
});
type Binding = z.infer<typeof bindingSchema>;
type Status = CloudState["bindings"][number];
/** Local disk is the durable outbox. Only an exact submitted version is acknowledged.
 * Each binding has its own baseline and crash-safe operation receipt, outside the project.
 */
export class CloudSync {
  private bindings = new Map<string, Binding>();
  private statuses = new Map<string, Status>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private firstDirty = new Map<string, number>();
  private failures = new Map<string, number>();
  private queue = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private polling?: ReturnType<typeof setInterval>;
  private active?: { projectId: string; designId: string };
  private pollTick = 0;
  private accountId?: string;
  private stopped = true;
  private detached = new Set<string>();
  private compute = new CloudCompute();
  constructor(
    private store: ProjectStore,
    private state: PrivateState,
    private remote: CloudRemote,
    private origin: string,
    private changed: () => void = () => {},
    private designsChanged: (projectId: string) => Promise<void> = async () => {},
  ) {}

  async initialize() {
    const index = z
      .array(z.uuid())
      .max(1000)
      .parse((await this.state.read("bindings")) ?? []);
    for (const id of index) {
      const binding = bindingSchema.parse(await this.state.read(id));
      if (binding.id !== id) throw new Error("Invalid cloud sync binding.");
      this.bindings.set(id, binding);
    }
  }
  get linkedProjects() {
    return [
      ...new Set([...this.bindings.values()].filter((b) => this.owns(b)).map((b) => b.projectId)),
    ];
  }
  get status() {
    return [...this.bindings.values()]
      .filter((b) => this.owns(b))
      .map(
        (b) =>
          this.statuses.get(b.id) ?? {
            projectId: b.projectId,
            designId: b.designId,
            fileId: b.fileId,
            organizationId: b.organizationId,
            status: b.conflict ? ("conflict" as const) : ("offline" as const),
          },
      );
  }
  get pendingFileIds() {
    return [...this.bindings.values()]
      .filter((b) => this.owns(b) && b.creating)
      .map((b) => b.fileId);
  }
  private owns(binding: Binding) {
    return (
      !this.detached.has(binding.id) &&
      binding.origin === this.origin &&
      binding.accountId === this.accountId &&
      this.store.projects.some((p) => p.id === binding.projectId && p.path === binding.projectPath)
    );
  }
  private publish(binding: Binding, status: Status["status"], message?: string) {
    const value = {
      projectId: binding.projectId,
      designId: binding.designId,
      fileId: binding.fileId,
      organizationId: binding.organizationId,
      status,
      ...(message ? { message } : {}),
    };
    if (JSON.stringify(this.statuses.get(binding.id)) === JSON.stringify(value)) return;
    this.statuses.set(binding.id, value);
    this.changed();
  }
  private async save(binding: Binding) {
    await this.state.write(binding.id, bindingSchema.parse(binding));
  }
  async start(accountId: string) {
    await this.stop();
    this.accountId = accountId;
    this.stopped = false;
    for (const binding of this.bindings.values())
      if (this.owns(binding)) this.schedule(binding.id, 0);
    // Bounded catch-up until the push-notification transport is connected.
    this.pollTick = 0;
    this.polling = setInterval(() => {
      this.pollTick++;
      for (const binding of this.bindings.values())
        if (
          this.owns(binding) &&
          !binding.conflict &&
          !this.failures.has(binding.id) &&
          (this.pollTick % 8 === 0 ||
            (binding.projectId === this.active?.projectId &&
              binding.designId === this.active?.designId))
        )
          this.schedule(binding.id, 0);
    }, 2_000);
    this.polling.unref?.();
    this.changed();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.polling);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.firstDirty.clear();
    this.queue.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.running.values()]);
    await this.compute.close();
    this.accountId = undefined;
    this.changed();
  }
  notify(projectId: string, designId?: string) {
    if (this.stopped) return;
    for (const binding of this.bindings.values())
      if (
        binding.projectId === projectId &&
        (!designId || binding.designId === designId) &&
        this.owns(binding) &&
        !this.failures.has(binding.id)
      )
        this.schedule(binding.id);
  }
  focus(projectId?: string, designId?: string) {
    this.active = projectId && designId ? { projectId, designId } : undefined;
    if (this.active)
      for (const binding of this.bindings.values()) {
        if (
          this.owns(binding) &&
          binding.projectId === projectId &&
          binding.designId === designId &&
          this.statuses.get(binding.id)?.status !== "paused"
        ) {
          this.failures.delete(binding.id);
          this.schedule(binding.id, 0);
        }
      }
  }
  private schedule(id: string, delay?: number) {
    const binding = this.bindings.get(id);
    if (this.stopped || !binding || !this.owns(binding) || binding.conflict) return;
    const first = this.firstDirty.get(id) ?? Date.now();
    this.firstDirty.set(id, first);
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(
        () => {
          this.timers.delete(id);
          this.firstDirty.delete(id);
          this.queue.add(id);
          this.pump();
        },
        delay ?? Math.max(0, Math.min(250, first + 1000 - Date.now())),
      ),
    );
  }
  private pump() {
    if (this.stopped) return;
    for (const id of this.queue) {
      if (this.running.size >= 2) break;
      if (this.running.has(id)) continue;
      this.queue.delete(id);
      const controller = new AbortController();
      this.controllers.set(id, controller);
      const work = this.reconcile(id, controller.signal)
        .catch((error: unknown) => {
          const binding = this.bindings.get(id);
          if (!binding || this.stopped) return;
          const paused =
            error instanceof CloudHTTPError && [400, 401, 403, 404, 413].includes(error.status);
          this.publish(
            binding,
            paused ? "paused" : "offline",
            paused ? error.message : "Changes stored locally. Retrying automatically.",
          );
          const count = (this.failures.get(id) ?? 0) + 1;
          this.failures.set(id, count);
          if (!paused)
            this.schedule(
              id,
              Math.min(60_000, 1000 * 2 ** Math.min(count, 6)) * (0.8 + Math.random() * 0.4),
            );
        })
        .finally(() => {
          this.running.delete(id);
          this.controllers.delete(id);
          this.pump();
        });
      this.running.set(id, work);
    }
  }
  private check(binding: Binding, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.stopped || !this.owns(binding)) throw new Error("Cloud sync is stopped.");
  }
  private local(binding: Binding) {
    return this.store.readDesign(binding.projectId, binding.designId, false);
  }
  private cloudDocument(binding: Binding, document: DesignDocument) {
    return this.compute.remap(document, binding.aliases);
  }
  private localDocument(binding: Binding, document: DesignDocument) {
    return this.compute.remap(
      document,
      Object.fromEntries(Object.entries(binding.aliases).map(([a, b]) => [b, a])),
    );
  }
  private async cacheAssets(binding: Binding, document: DesignDocument, signal?: AbortSignal) {
    for (const id of documentAssetIds(document)) {
      const localId =
        Object.entries(binding.aliases).find(([, remote]) => remote === id)?.[0] ?? id;
      if (await this.store.readSyncAsset(binding.projectId, localId)) continue;
      const dataUrl = await this.remote.downloadAsset(binding.fileId, id, signal);
      this.check(binding, signal);
      await this.store.cacheSyncAsset(binding.projectId, localId, dataUrl);
    }
  }
  private async prepareAssets(binding: Binding, document: DesignDocument, signal?: AbortSignal) {
    const known = new Set(documentAssetIds(binding.base.content));
    for (const id of documentAssetIds(document)) {
      if (known.has(id) || binding.aliases[id]) continue;
      const dataUrl = await this.store.readSyncAsset(binding.projectId, id);
      if (!dataUrl) throw new Error("A local image is missing. Restore it to resume sync.");
      const remoteId = await this.remote.uploadAsset(binding.fileId, dataUrl, signal);
      this.check(binding, signal);
      binding.aliases[id] = remoteId;
      await this.save(binding);
    }
  }
  /** Serialized by the coordinator; public for deterministic transport/restart tests. */
  async reconcile(id: string, signal?: AbortSignal) {
    const binding = this.bindings.get(id);
    if (!binding || binding.conflict) return;
    this.check(binding, signal);
    if (binding.pending || binding.creating) this.publish(binding, "syncing");
    if (binding.creating) {
      await this.remote.create(
        binding.creating.organizationId,
        binding.fileId,
        binding.creating.name,
        signal,
      );
      const remote = await this.remote.read(binding.fileId, undefined, signal);
      this.check(binding, signal);
      // Another client may edit the new file after creation. Reconcile against
      // the originally empty document instead of silently adopting their work.
      if (remote.revision !== 1 || remote.content.nodes.length) {
        binding.conflict = remote;
        await this.save(binding);
        this.publish(
          binding,
          "conflict",
          "The new cloud file was edited elsewhere. Keep both copies to continue.",
        );
        return;
      }
      binding.base = remote;
      binding.creating = undefined;
      await this.save(binding);
    }
    if (binding.pending) {
      const pending = binding.pending;
      let acknowledged: CloudSnapshot;
      try {
        acknowledged = await this.remote.commit(binding.fileId, pending, signal);
      } catch (error) {
        if (!(error instanceof CloudHTTPError) || error.status !== 409) throw error;
        const remote = await this.remote.read(binding.fileId, undefined, signal);
        this.check(binding, signal);
        // Never replay an expired operation against a fresh base. Preserve both sides.
        binding.conflict = remote;
        await this.save(binding);
        this.publish(binding, "conflict", "Both copies changed. Keep both to continue.");
        return;
      }
      this.check(binding, signal);
      const current = await this.local(binding);
      if (await this.compute.equal(current.document, pending.local)) {
        const canonical = await this.localDocument(binding, acknowledged.content);
        if (!(await this.compute.equal(current.document, canonical))) {
          await this.store.updateDesign({
            projectId: binding.projectId,
            designId: binding.designId,
            expectedVersion: current.version,
            document: canonical,
          });
          await this.designsChanged(binding.projectId);
        }
      }
      binding.base = acknowledged;
      binding.pending = undefined;
      await this.save(binding);
      this.failures.delete(id);
      const latest = await this.local(binding);
      if (
        (latest.name !== binding.name && binding.name !== undefined) ||
        !(await this.compute.equal(
          await this.cloudDocument(binding, latest.document),
          binding.base.content,
        ))
      )
        this.schedule(id);
      else this.publish(binding, "synced");
      // Acknowledgements carry the original canonical patch. Avoid another GET
      // after every upload; normal catch-up discovers later remote revisions.
      return;
    }
    let local = await this.local(binding);
    const remote = await this.remote.read(binding.fileId, binding.base, signal);
    this.check(binding, signal);
    if (remote.name !== undefined && this.remote.rename) {
      if (binding.name === undefined) {
        binding.name = remote.name;
        await this.save(binding);
      }
      if (binding.pendingName) {
        const pending = binding.pendingName;
        if (remote.name !== pending.name) {
          if (remote.name !== pending.before) {
            binding.conflict = remote;
            await this.save(binding);
            this.publish(
              binding,
              "conflict",
              "Both copies were renamed. Keep both copies to continue.",
            );
            return;
          }
          await this.remote.rename(binding.fileId, pending.before, pending.name, signal);
          this.check(binding, signal);
        }
        binding.name = pending.name;
        remote.name = pending.name;
        binding.pendingName = undefined;
        await this.save(binding);
      }
      const localRenamed = local.name !== binding.name,
        remoteRenamed = remote.name !== binding.name;
      if (localRenamed && remoteRenamed && local.name !== remote.name) {
        binding.conflict = remote;
        await this.save(binding);
        this.publish(
          binding,
          "conflict",
          "Both copies were renamed. Keep both copies to continue.",
        );
        return;
      }
      if (localRenamed) {
        this.publish(binding, "syncing");
        binding.pendingName = { before: binding.name, name: local.name };
        await this.save(binding);
        await this.remote.rename(binding.fileId, binding.name, local.name, signal);
        this.check(binding, signal);
        binding.name = local.name;
        binding.pendingName = undefined;
        await this.save(binding);
      } else if (remoteRenamed) {
        local = await this.store.updateDesign({
          projectId: binding.projectId,
          designId: binding.designId,
          expectedVersion: local.version,
          name: remote.name,
        });
        binding.name = remote.name;
        await this.save(binding);
        await this.designsChanged(binding.projectId);
      }
    }
    const document = await this.cloudDocument(binding, local.document);
    const localChanged = !(await this.compute.equal(document, binding.base.content));
    const remoteChanged = !(await this.compute.equal(remote.content, binding.base.content));
    if (localChanged || remoteChanged) this.publish(binding, "syncing");
    if (localChanged && remoteChanged && !(await this.compute.equal(document, remote.content))) {
      binding.conflict = remote;
      await this.save(binding);
      this.publish(binding, "conflict", "Both copies changed. Keep both to continue.");
      return;
    }
    if (remoteChanged) {
      await this.cacheAssets(binding, remote.content, signal);
      this.check(binding, signal);
      if (!(await this.compute.equal(document, remote.content))) {
        await this.store.updateDesign({
          projectId: binding.projectId,
          designId: binding.designId,
          expectedVersion: local.version,
          document: await this.localDocument(binding, remote.content),
        });
        await this.designsChanged(binding.projectId);
      }
      binding.base = remote;
      await this.save(binding);
    } else if (localChanged) {
      await this.prepareAssets(binding, local.document, signal);
      this.check(binding, signal);
      binding.base = remote;
      binding.pending = {
        operationId: randomUUID(),
        base: remote,
        patch: await this.compute.diff(
          remote.content,
          await this.cloudDocument(binding, local.document),
        ),
        local: local.document,
      };
      // Persist the immutable payload and operation ID before sending anything.
      await this.save(binding);
      this.schedule(id, 0);
      return;
    } else if (binding.base.revision !== remote.revision) {
      binding.base = remote;
      await this.save(binding);
    }
    this.failures.delete(id);
    const latest = await this.local(binding);
    if (
      (latest.name !== binding.name && binding.name !== undefined) ||
      !(await this.compute.equal(
        await this.cloudDocument(binding, latest.document),
        binding.base.content,
      ))
    )
      this.schedule(id);
    else this.publish(binding, "synced");
  }
  async open(
    projectId: string,
    fileId: string,
    name: string,
    organizationId?: string,
  ): Promise<LocalDesign> {
    if (!this.accountId || this.stopped) throw new Error("Sign in to open a cloud design.");
    const accountId = this.accountId;
    const project = this.store.project(projectId);
    const existing = [...this.bindings.values()].find(
      (b) => this.owns(b) && b.projectId === projectId && b.fileId === fileId,
    );
    if (existing) return this.store.readDesign(projectId, existing.designId);
    const remote = await this.remote.read(fileId);
    const binding: Binding = {
      id: randomUUID(),
      projectId,
      projectPath: project.path,
      designId: randomUUID(),
      fileId,
      organizationId,
      name: remote.name ?? name,
      origin: this.origin,
      accountId,
      base: remote,
      aliases: {},
    };
    await this.cacheAssets(binding, remote.content);
    this.check(binding);
    const design = await this.store.createDesign(projectId, {
      name: remote.name ?? name,
      document: remote.content,
    });
    binding.designId = design.id;
    await this.save(binding);
    await this.state.write("bindings", [...this.bindings.keys(), binding.id]);
    this.bindings.set(binding.id, binding);
    this.publish(binding, "synced");
    await this.designsChanged(projectId);
    return design;
  }
  async connectLocal(projectId: string, designId: string, organizationId: string) {
    if (!this.accountId || this.stopped) throw new Error("Sign in to sync a local design.");
    if (
      [...this.bindings.values()].some(
        (b) => this.owns(b) && b.projectId === projectId && b.designId === designId,
      )
    )
      throw new Error("This design is already connected.");
    const accountId = this.accountId;
    const local = await this.store.readDesign(projectId, designId, false);
    const binding: Binding = {
      id: randomUUID(),
      projectId,
      projectPath: this.store.project(projectId).path,
      designId,
      fileId: randomUUID(),
      organizationId,
      name: local.name,
      origin: this.origin,
      accountId,
      base: { revision: 0, content: blankDesignDocument() },
      aliases: {},
      creating: { organizationId, name: local.name },
    };
    this.check(binding);
    await this.save(binding);
    await this.state.write("bindings", [...this.bindings.keys(), binding.id]);
    this.bindings.set(binding.id, binding);
    this.publish(binding, "syncing");
    this.schedule(binding.id, 0);
  }
  async disconnect(projectId: string, designId: string) {
    const binding = [...this.bindings.values()].find(
      (b) => this.owns(b) && b.projectId === projectId && b.designId === designId,
    );
    if (!binding) return;
    this.detached.add(binding.id);
    clearTimeout(this.timers.get(binding.id));
    this.queue.delete(binding.id);
    this.controllers.get(binding.id)?.abort();
    await this.running.get(binding.id);
    clearTimeout(this.timers.get(binding.id));
    this.queue.delete(binding.id);
    await this.state.write(
      "bindings",
      [...this.bindings.keys()].filter((id) => id !== binding.id),
    );
    this.bindings.delete(binding.id);
    this.statuses.delete(binding.id);
    await this.state.remove(binding.id);
    this.changed();
  }
}
