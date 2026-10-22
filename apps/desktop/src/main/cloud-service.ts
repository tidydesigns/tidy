import { createHash } from "node:crypto";
import { z } from "zod";
import {
  cloudAccountSchema,
  cloudCatalogSchema,
  cloudThumbnailSchema,
  type CloudAPI,
  type CloudState,
  type CloudOpened,
} from "../shared/cloud-sync";
import { CloudAuth } from "./cloud-auth";
import { CloudSync } from "./cloud-sync";
import { HTTPCloudRemote, type CloudRemote } from "./cloud-remote";
import { PrivateState } from "./private-state";
import { WorkspaceService } from "./workspace-service";
type LibraryRemote = CloudRemote &
  Pick<HTTPCloudRemote, "account" | "catalog" | "files" | "thumbnail">;
const thumbnailCacheSchema = z.object({ version: z.string(), image: cloudThumbnailSchema });

/** Own the optional account connection separately from local workspace availability. */
export class CloudService implements CloudAPI {
  readonly sync: CloudSync;
  private remote: LibraryRemote;
  private listeners = new Set<(state: CloudState) => void>();
  private unsubscribe: () => void;
  private action = Promise.resolve();
  private enabled = true;
  private initialization?: Promise<void>;
  private initialized = false;
  private closed = false;
  private generation = 0;
  private designVersions = new Map<string, string>();
  private thumbnailWork = new Map<string, Promise<string | null>>();
  private thumbnailQueue: (() => void)[] = [];
  private thumbnailCount = 0;
  constructor(
    private auth: CloudAuth,
    private service: WorkspaceService,
    private privateState: PrivateState,
    remote?: LibraryRemote,
  ) {
    this.remote = remote ?? new HTTPCloudRemote(auth);
    this.sync = new CloudSync(
      service.store,
      privateState,
      this.remote,
      auth.origin,
      () => this.emit(),
      (id) => service.refreshDesigns(id),
    );
    this.unsubscribe = service.subscribe((event) => {
      if (event.type !== "designs") return;
      for (const design of event.designs) {
        const key = `${event.projectId}:${design.id}`;
        if (this.designVersions.get(key) !== design.updatedAt) {
          this.designVersions.set(key, design.updatedAt);
          this.sync.notify(event.projectId, design.id);
        }
      }
    });
  }
  initialize() {
    return (this.initialization ??= this.load());
  }
  private async load() {
    try {
      await this.privateState.initialize();
      await this.auth.initialize();
      await this.sync.initialize();
      if (this.auth.accountId && !this.closed) await this.resume();
    } catch {
      // Unreadable credentials or private state must never prevent local editing.
      this.enabled = false;
    }
    this.initialized = true;
    this.emit();
  }
  private async resume() {
    if (!this.auth.accountId || this.closed) return;
    await this.sync.start(this.auth.accountId);
    for (const projectId of this.sync.linkedProjects)
      await this.service.observe(projectId).catch(() => {});
    this.emit();
  }
  async state(): Promise<CloudState> {
    return {
      available: this.initialized && this.enabled && this.auth.available,
      signedIn: Boolean(this.auth.accountId),
      accountId: this.auth.accountId,
      bindings: this.sync.status,
    };
  }
  private emit() {
    void this.state().then((state) => {
      for (const listener of this.listeners) listener(state);
    });
  }
  onState(listener: (state: CloudState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  signIn() {
    const generation = this.generation;
    const work = this.action.then(async () => {
      await this.initialize();
      if (generation !== this.generation || this.closed)
        throw new Error("Cloud sign-in was cancelled.");
      if (!this.enabled) throw new Error("Cloud sync private state could not be read.");
      await this.sync.stop();
      await this.auth.signIn();
      if (generation === this.generation && !this.closed) await this.resume();
    });
    this.action = work.catch(() => {});
    return work;
  }
  async signOut() {
    this.generation++;
    // Cancel an outstanding browser login immediately, then stop account-bound work.
    this.auth.cancelSignIn();
    await this.initialize();
    await this.sync.stop();
    await this.auth.signOut();
    this.emit();
    await this.action;
  }
  private cacheKey(kind: string, organizationId = "") {
    if (!this.auth.accountId) throw new Error("Sign in to Tidy to open your workspace.");
    return `${kind}-${createHash("sha256")
      .update(JSON.stringify([this.auth.origin, this.auth.accountId, organizationId]))
      .digest("hex")}`;
  }
  async account(cachedOnly = false) {
    await this.initialize();
    const key = this.cacheKey("account"),
      generation = this.generation;
    if (cachedOnly) return cloudAccountSchema.parse(await this.privateState.read(key));
    const account = await this.remote.account();
    if (generation !== this.generation || account.id !== this.auth.accountId)
      throw new Error("The account changed.");
    await this.privateState.write(key, account);
    return account;
  }
  async catalog(organizationId: string, cachedOnly = false) {
    await this.initialize();
    const key = this.cacheKey("catalog", organizationId),
      generation = this.generation;
    if (cachedOnly) return cloudCatalogSchema.parse(await this.privateState.read(key));
    const catalog = await this.remote.catalog(organizationId);
    if (generation !== this.generation) throw new Error("The account changed.");
    const cached = cloudCatalogSchema.safeParse(await this.privateState.read(key));
    if (cached.success) {
      const pending = new Set(this.sync.pendingFileIds);
      catalog.files.push(
        ...cached.data.files.filter(
          (f) => pending.has(f.id) && !catalog.files.some((remote) => remote.id === f.id),
        ),
      );
    }
    await this.privateState.write(key, catalog);
    return catalog;
  }
  private async workspace(organizationId: string) {
    const account = await this.account(true).catch(() => this.account());
    const organization = account.organizations.find((o) => o.id === organizationId && o.canEdit);
    if (!organization) throw new Error("You need editing access to this workspace.");
    const key = this.cacheKey("workspace", organizationId).slice("workspace-".length);
    const path = await this.privateState.workspace(key);
    const existing = this.service.store.projects.find((p) => p.path === path && p.cloud);
    const project = existing ?? (await this.service.store.open(path, organization.name)).project;
    await this.service.observe(project.id);
    return project;
  }
  private fileAction(action: () => Promise<CloudOpened>) {
    const generation = this.generation;
    const work = this.action.then(async () => {
      await this.initialize();
      if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
      const value = await action();
      if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
      return value;
    });
    this.action = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  openFile(organizationId: string, fileId: string) {
    return this.fileAction(async () => {
      const catalog = await this.catalog(organizationId, true).catch(() =>
        this.catalog(organizationId),
      );
      const file = catalog.files.find((f) => f.id === fileId);
      if (!file) throw new Error("This file is no longer in this workspace.");
      const project = await this.workspace(organizationId);
      const design = await this.sync.open(project.id, fileId, file.name, organizationId);
      return { projectId: project.id, design };
    });
  }
  createFile(organizationId: string) {
    return this.fileAction(async () => {
      const project = await this.workspace(organizationId);
      const design = await this.service.store.createDesign(project.id);
      await this.sync.connectLocal(project.id, design.id, organizationId);
      await this.rememberFile(organizationId, project.id, design);
      await this.service.refreshDesigns(project.id);
      return { projectId: project.id, design };
    });
  }
  private async rememberFile(
    organizationId: string,
    projectId: string,
    design: { id: string; name: string; updatedAt: string },
  ) {
    const binding = this.sync.status.find(
      (b) => b.projectId === projectId && b.designId === design.id,
    );
    if (!binding) return;
    const key = this.cacheKey("catalog", organizationId);
    const cached = cloudCatalogSchema.safeParse(await this.privateState.read(key));
    const catalog = cached.success ? cached.data : { files: [], folders: [] };
    catalog.files = [
      { id: binding.fileId, name: design.name, folderId: null, updatedAt: design.updatedAt },
      ...catalog.files.filter((f) => f.id !== binding.fileId),
    ];
    await this.privateState.write(key, catalog);
  }
  keepBoth(organizationId: string, projectId: string, designId: string) {
    return this.fileAction(async () => {
      const binding = this.sync.status.find(
        (b) => b.projectId === projectId && b.designId === designId && b.status === "conflict",
      );
      if (!binding) throw new Error("This file no longer has conflicting edits.");
      const catalog = await this.catalog(organizationId);
      const original = catalog.files.find((f) => f.id === binding.fileId);
      if (!original) throw new Error("This file is no longer in this workspace.");
      await this.remote.read(binding.fileId);
      const local = await this.service.store.readDesign(projectId, designId);
      await this.service.store.updateDesign({
        projectId,
        designId,
        expectedVersion: local.version,
        name: `${local.name.slice(0, 106)} (local copy)`,
      });
      await this.sync.disconnect(projectId, designId);
      await this.sync.connectLocal(projectId, designId, organizationId);
      await this.rememberFile(
        organizationId,
        projectId,
        await this.service.store.readDesign(projectId, designId),
      );
      const design = await this.sync.open(projectId, binding.fileId, original.name, organizationId);
      await this.service.refreshDesigns(projectId);
      return { projectId, design };
    });
  }
  async focus(projectId?: string, designId?: string) {
    this.sync.focus(projectId, designId);
  }
  thumbnail(fileId: string, version: string) {
    const key = this.cacheKey("thumbnail", fileId),
      requestKey = `${key}:${version}`,
      generation = this.generation;
    const existing = this.thumbnailWork.get(requestKey);
    if (existing) return existing;
    const work = new Promise<string | null>((resolve, reject) => {
      const run = () => {
        this.thumbnailCount++;
        void (async () => {
          if (generation !== this.generation || this.closed) return null;
          const cached = thumbnailCacheSchema.safeParse(await this.privateState.read(key));
          if (cached.success && cached.data.version === version && cached.data.image)
            return cached.data.image;
          const value = await this.remote.thumbnail(fileId);
          if (generation !== this.generation || this.closed) return null;
          if (value) await this.privateState.write(key, { version, image: value });
          return value;
        })()
          .then(resolve, reject)
          .finally(() => {
            this.thumbnailCount--;
            this.thumbnailWork.delete(requestKey);
            this.thumbnailQueue.shift()?.();
          });
      };
      if (this.thumbnailCount < 3) run();
      else this.thumbnailQueue.push(run);
    });
    this.thumbnailWork.set(requestKey, work);
    return work;
  }
  async files(id: string) {
    return this.remote.files(id);
  }
  async open(projectId: string, fileId: string, name: string) {
    const generation = this.generation;
    const work = this.action.then(async () => {
      await this.initialize();
      if (this.closed || generation !== this.generation) throw new Error("Cloud sync is stopped.");
      await this.sync.open(projectId, fileId, name);
      await this.service.observe(projectId);
    });
    this.action = work.catch(() => {});
    await work;
  }
  async disconnect(projectId: string, designId: string) {
    const work = this.action.then(() => this.sync.disconnect(projectId, designId));
    this.action = work.catch(() => {});
    await work;
  }
  async connectLocal(projectId: string, designId: string, organizationId: string) {
    const generation = this.generation;
    const work = this.action.then(async () => {
      await this.initialize();
      if (this.closed || generation !== this.generation) throw new Error("Cloud sync is stopped.");
      await this.sync.connectLocal(projectId, designId, organizationId);
      await this.rememberFile(
        organizationId,
        projectId,
        await this.service.store.readDesign(projectId, designId),
      );
      await this.service.observe(projectId);
    });
    this.action = work.catch(() => {});
    await work;
  }
  async close() {
    this.closed = true;
    this.generation++;
    this.auth.cancelSignIn();
    this.unsubscribe();
    await this.sync.stop();
  }
}
