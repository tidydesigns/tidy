import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  cloudAccountSchema,
  cloudCatalogSchema,
  cloudThumbnailSchema,
  cloudAvatarSchema,
  type CloudAPI,
  type CloudState,
  type CloudAccount,
  type CloudOpened,
} from "../../shared/contracts/cloud-sync";
import type { ProjectSnapshot } from "../../shared/contracts/desktop";
import { CloudAuth } from "./cloud-auth";
import { CloudSync } from "./cloud-sync";
import { HTTPCloudRemote, type CloudRemote } from "./cloud-remote";
import { PrivateState } from "../platform/private-state";
import { WorkspaceService } from "../workspace/workspace-service";
type LibraryRemote = CloudRemote &
  Pick<HTTPCloudRemote, "account" | "catalog" | "files" | "thumbnail" | "creatorAvatar">;

/** Own the optional account connection separately from local workspace availability. */
export class CloudService implements CloudAPI {
  readonly sync: CloudSync;
  private remote: LibraryRemote;
  private listeners = new Set<(state: CloudState) => void>();
  private emitQueued = false;
  private unsubscribe: () => void;
  private action = Promise.resolve();
  private enabled = true;
  private initialization?: Promise<void>;
  private initialized = false;
  private closed = false;
  private generation = 0;
  private accountChanging = false;
  private latestAccount?: CloudAccount;
  private accountRequest = 0;
  private accountWrites = Promise.resolve();
  private updateAccountRequest?: Promise<CloudAccount>;
  private designVersions = new Map<string, string>();
  private workspaceWork = new Map<string, Promise<ProjectSnapshot>>();
  private workspaces = new Map<string, { accountId: string; organizationId: string }>();
  private thumbnailWork = new Map<string, Promise<string | null>>();
  private thumbnailQueue: (() => void)[] = [];
  private thumbnailCount = 0;
  constructor(
    private auth: CloudAuth,
    private service: WorkspaceService,
    private privateState: PrivateState,
    remote?: LibraryRemote,
    private workspaceAvailable = true,
  ) {
    service.canAccessCloudProject = (projectId) => {
      const binding = this.workspaces.get(projectId);
      return Boolean(
        !this.closed &&
        !this.accountChanging &&
        binding &&
        binding.accountId === this.auth.accountId &&
        this.latestAccount?.id === binding.accountId &&
        this.latestAccount.organizations.some(
          (org) => org.id === binding.organizationId && org.canEdit,
        ),
      );
    };
    service.authorizeCloudProject = async (projectId) => {
      const binding = this.workspaces.get(projectId);
      const generation = this.generation;
      if (
        this.closed ||
        this.accountChanging ||
        !binding ||
        binding.accountId !== this.auth.accountId
      )
        throw new Error("Open this workspace with its signed-in account before running agents.");
      const account =
        this.latestAccount?.id === this.auth.accountId
          ? this.latestAccount
          : await this.account(true);
      if (
        generation !== this.generation ||
        account.id !== binding.accountId ||
        !account.organizations.some((o) => o.id === binding.organizationId && o.canEdit)
      )
        throw new Error("You need editing access to this workspace.");
    };
    service.restoreUpdateAccess = async (projectId) => {
      if (service.canAccessProject(projectId)) return;
      this.assertWorkspaceAvailable();
      await this.initialize();
      const project = service.store.project(projectId);
      const account = await this.accountForUpdate();
      const organization = account.organizations.find((org) => {
        const key = this.cacheKey("workspace", org.id).slice("workspace-".length);
        return org.canEdit && project.path.endsWith(`/workspace-${key}`);
      });
      if (!organization || (await this.workspace(organization.id)).id !== projectId)
        throw new Error("Open this workspace with its signed-in account before continuing.");
      await service.assertProjectAccess(projectId);
    };
    service.coordinateDesignSync = async (projectId, designId, connect, assertActive) => {
      await service.assertProjectAccess(projectId);
      const workspace = this.workspaces.get(projectId);
      if (!workspace || workspace.accountId !== this.auth.accountId)
        throw new Error("Open this workspace with its signed-in account before syncing designs.");
      const existing = () =>
        this.sync.status.find((b) => b.projectId === projectId && b.designId === designId);
      if (connect && !existing()) {
        try {
          await this.connectLocal(projectId, designId, workspace.organizationId, assertActive);
        } catch (error) {
          // Concurrent opens share the binding created by the first queued request.
          if (!existing()) throw error;
        }
      }
      await service.assertProjectAccess(projectId);
      const binding = existing();
      return binding
        ? { fileId: binding.fileId, status: binding.status, message: binding.message }
        : undefined;
    };
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
    if (!this.workspaceAvailable || !this.auth.accountId || this.closed) return;
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
      bindings:
        this.workspaceAvailable && this.auth.accountId && !this.accountChanging
          ? this.sync.status
          : [],
    };
  }
  private emit() {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      void this.state().then((state) => {
        for (const listener of this.listeners) listener(state);
      });
    });
  }
  onState(listener: (state: CloudState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  signIn() {
    const previousAccount = this.latestAccount;
    const previousWorkspaces = new Map(this.workspaces);
    const generation = ++this.generation;
    this.accountChanging = true;
    this.latestAccount = undefined;
    this.workspaces.clear();
    this.workspaceWork.clear();
    const work = this.action.then(async () => {
      await this.initialize();
      if (generation !== this.generation || this.closed)
        throw new Error("Cloud sign-in was cancelled.");
      if (!this.enabled) throw new Error("Cloud sync private state could not be read.");
      this.accountChanging = true;
      this.workspaces.clear();
      this.workspaceWork.clear();
      await this.service.stopCloudThreads();
      await this.sync.stop();
      try {
        await this.auth.signIn();
      } finally {
        if (generation === this.generation && !this.closed) {
          if (previousAccount?.id === this.auth.accountId) await this.account(true).catch(() => {});
          if (generation === this.generation && !this.closed) {
            this.accountChanging = false;
            if (previousAccount?.id === this.auth.accountId) {
              for (const [id, binding] of previousWorkspaces) {
                if (binding.accountId === this.auth.accountId) this.workspaces.set(id, binding);
              }
            }
            await this.resume();
          }
        }
      }
    });
    this.action = work.catch(() => {});
    return work;
  }
  async signOut() {
    this.accountChanging = true;
    this.latestAccount = undefined;
    this.workspaces.clear();
    this.workspaceWork.clear();
    this.generation++;
    // Cancel an outstanding browser login immediately, then stop account-bound work.
    this.auth.cancelSignIn();
    await this.initialize();
    await this.service.stopCloudThreads();
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
    const request = cachedOnly ? this.accountRequest : ++this.accountRequest;
    const account = cachedOnly
      ? cloudAccountSchema.parse(await this.privateState.read(key))
      : await this.remote.account();
    if (generation !== this.generation || account.id !== this.auth.accountId)
      throw new Error("The account changed.");
    if (cachedOnly && this.latestAccount?.id === account.id)
      return structuredClone(this.latestAccount);
    if (request !== this.accountRequest)
      throw new Error("Newer account metadata is loading. Try again.");
    if (!cachedOnly) {
      const write = this.accountWrites.then(async () => {
        if (generation !== this.generation || request !== this.accountRequest || this.closed)
          throw new Error("The account changed.");
        await this.privateState.write(key, account);
      });
      this.accountWrites = write.catch(() => {});
      await write;
    }
    if (generation !== this.generation || this.closed) throw new Error("The account changed.");
    if (request !== this.accountRequest)
      throw new Error("Newer account metadata is loading. Try again.");
    this.latestAccount = cloudAccountSchema.parse(account);
    return account;
  }
  /** Share a fresh lookup across concurrent thread recoveries without racing account generations. */
  private accountForUpdate() {
    if (this.updateAccountRequest) return this.updateAccountRequest;
    const request = this.account()
      .catch((error: unknown) => {
        if (
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "TimeoutError")
        )
          return this.account(true);
        throw error;
      })
      .finally(() => {
        if (this.updateAccountRequest === request) this.updateAccountRequest = undefined;
      });
    this.updateAccountRequest = request;
    return request;
  }
  async catalog(organizationId: string, cachedOnly = false) {
    await this.initialize();
    const key = this.cacheKey("catalog", organizationId),
      generation = this.generation;
    if (cachedOnly) {
      const catalog = cloudCatalogSchema.parse(await this.privateState.read(key));
      if (generation !== this.generation || this.closed) throw new Error("The account changed.");
      return catalog;
    }
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
    if (generation !== this.generation || this.closed) throw new Error("The account changed.");
    await this.privateState.write(key, catalog);
    if (generation !== this.generation || this.closed) throw new Error("The account changed.");
    return catalog;
  }
  private assertWorkspaceAvailable() {
    if (!this.workspaceAvailable)
      throw new Error(
        "Cloud workspaces are unavailable while attached to a background backend. Once its agents finish, stop that backend and reopen Tidy to use cloud workspaces.",
      );
  }
  async openWorkspace(organizationId: string) {
    this.assertWorkspaceAvailable();
    const generation = this.generation;
    await this.initialize();
    const key = this.cacheKey("workspace", organizationId);
    const pending = this.workspaceWork.get(key);
    if (pending) return pending;
    const work = (async () => {
      const project = await this.workspace(organizationId);
      await this.service.assertProjectAccess(project.id);
      const snapshot = await this.service.store.snapshot(project.id);
      await this.service.assertProjectAccess(project.id);
      if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
      return { ...snapshot, threads: this.service.withLiveThreads(project.id, snapshot.threads) };
    })();
    this.workspaceWork.set(key, work);
    void work
      .finally(() => {
        if (this.workspaceWork.get(key) === work) this.workspaceWork.delete(key);
      })
      .catch(() => {});
    return work;
  }
  private async workspace(organizationId: string) {
    this.assertWorkspaceAvailable();
    if (this.closed || this.accountChanging) throw new Error("Cloud sync is stopped.");
    const generation = this.generation;
    const account =
      this.latestAccount && this.latestAccount.id === this.auth.accountId
        ? this.latestAccount
        : await this.account(true).catch(() => this.account());
    const organization = account.organizations.find((o) => o.id === organizationId && o.canEdit);
    if (!organization) throw new Error("You need editing access to this workspace.");
    const key = this.cacheKey("workspace", organizationId).slice("workspace-".length);
    const path = await realpath(await this.privateState.workspace(key));
    const existing = this.service.store.projects.find((p) => p.path === path && p.cloud);
    const project = existing ?? (await this.service.store.register(path, organization.name));
    if (generation !== this.generation || this.closed || account.id !== this.auth.accountId)
      throw new Error("Cloud sync is stopped.");
    this.workspaces.set(project.id, { accountId: account.id, organizationId });
    await this.service.observe(project.id);
    return project;
  }
  private fileAction(action: () => Promise<CloudOpened>) {
    const generation = this.generation;
    const work = this.action.then(async () => {
      this.assertWorkspaceAvailable();
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
  async openFile(organizationId: string, fileId: string) {
    this.assertWorkspaceAvailable();
    const generation = this.generation;
    await this.initialize();
    if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
    const cached = this.sync.status.find(
      (binding) => binding.fileId === fileId && binding.organizationId === organizationId,
    );
    const open = async (binding?: typeof cached): Promise<CloudOpened> => {
      const catalog = await this.catalog(organizationId, true).catch(() =>
        this.catalog(organizationId),
      );
      const file = catalog.files.find((f) => f.id === fileId);
      if (!file) throw new Error("This file is no longer in this workspace.");
      const project = await this.workspace(organizationId);
      if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
      const stillBound = () =>
        this.sync.status.some(
          (current) =>
            current.fileId === fileId &&
            current.projectId === project.id &&
            current.designId === binding?.designId,
        );
      if (binding && !stillBound()) return this.fileAction(() => open());
      const design = binding
        ? await this.service.store.readDesign(project.id, binding.designId)
        : await this.sync.open(project.id, fileId, file.name, organizationId);
      if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
      // A concurrent disconnect/keep-both may replace this binding during disk I/O.
      if (binding && !stillBound()) return this.fileAction(() => open());
      return { projectId: project.id, design };
    };
    // Reading an existing binding is independent of another file's download.
    // New bindings and destructive/account actions retain their serialization.
    return cached ? open(cached) : this.fileAction(() => open());
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
      await this.service.assertProjectAccess(projectId);
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
      await this.service.assertProjectAccess(projectId);
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
    if (projectId) {
      this.assertWorkspaceAvailable();
      await this.service.assertProjectAccess(projectId);
    }
    this.sync.focus(projectId, designId);
  }
  async loadAsset(projectId: string, assetId: string) {
    this.assertWorkspaceAvailable();
    const generation = this.generation;
    await this.service.assertProjectAccess(projectId);
    if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
    const dataUrl = await this.sync.loadAsset(projectId, assetId);
    await this.service.assertProjectAccess(projectId);
    if (generation !== this.generation || this.closed) throw new Error("Cloud sync is stopped.");
    return dataUrl;
  }
  setForeground(value: boolean) {
    this.sync.setForeground(value);
  }
  thumbnail(fileId: string, version: string) {
    return this.cachedImage("thumbnail", fileId, version, () => this.remote.thumbnail(fileId));
  }
  creatorAvatar(fileId: string, creatorId: string, version: string) {
    return this.cachedImage("creator-avatar", creatorId, version, () =>
      this.remote.creatorAvatar(fileId, creatorId, version),
    );
  }
  private cachedImage(
    kind: "thumbnail" | "creator-avatar",
    id: string,
    version: string,
    load: () => Promise<string | null>,
  ) {
    const schema = z.object({
      version: z.string(),
      image: kind === "thumbnail" ? cloudThumbnailSchema : cloudAvatarSchema,
    });
    const key = this.cacheKey(kind, id),
      requestKey = `${key}:${version}`,
      generation = this.generation,
      accountId = this.auth.accountId;
    const current = () =>
      generation === this.generation && accountId === this.auth.accountId && !this.closed;
    const existing = this.thumbnailWork.get(requestKey);
    if (existing) return existing;
    const work = (async () => {
      if (!current()) return null;
      const cached = schema.safeParse(await this.privateState.read(key));
      if (!current()) return null;
      if (cached.success && cached.data.version === version && cached.data.image)
        return cached.data.image;
      return new Promise<string | null>((resolve, reject) => {
        const run = () => {
          this.thumbnailCount++;
          void (async () => {
            if (!current()) return null;
            const value = await load();
            if (!current()) return null;
            if (value) await this.privateState.write(key, { version, image: value });
            return current() ? value : null;
          })()
            .then(resolve, reject)
            .finally(() => {
              this.thumbnailCount--;
              this.thumbnailQueue.shift()?.();
            });
        };
        if (this.thumbnailCount < 3) run();
        else this.thumbnailQueue.push(run);
      });
    })().finally(() => this.thumbnailWork.delete(requestKey));
    this.thumbnailWork.set(requestKey, work);
    return work;
  }
  async files(id: string) {
    const generation = this.generation;
    await this.initialize();
    const accountId = this.auth.accountId;
    const current = () =>
      generation === this.generation &&
      accountId === this.auth.accountId &&
      Boolean(accountId) &&
      !this.accountChanging &&
      !this.closed;
    if (!current()) throw new Error("The account changed.");
    const files = await this.remote.files(id);
    if (!current()) throw new Error("The account changed.");
    return files;
  }
  async open(projectId: string, fileId: string, name: string) {
    this.assertWorkspaceAvailable();
    const generation = this.generation;
    const work = this.action.then(async () => {
      await this.initialize();
      if (this.closed || generation !== this.generation) throw new Error("Cloud sync is stopped.");
      await this.service.assertProjectAccess(projectId);
      await this.sync.open(projectId, fileId, name);
      await this.service.observe(projectId);
    });
    this.action = work.catch(() => {});
    await work;
  }
  async disconnect(projectId: string, designId: string) {
    this.assertWorkspaceAvailable();
    const work = this.action.then(async () => {
      await this.service.assertProjectAccess(projectId);
      await this.sync.disconnect(projectId, designId);
    });
    this.action = work.catch(() => {});
    await work;
  }
  async connectLocal(
    projectId: string,
    designId: string,
    organizationId: string,
    assertActive?: () => void,
  ) {
    this.assertWorkspaceAvailable();
    const generation = this.generation;
    const work = this.action.then(async () => {
      await this.initialize();
      if (this.closed || generation !== this.generation) throw new Error("Cloud sync is stopped.");
      await this.service.assertProjectAccess(projectId);
      assertActive?.();
      await this.sync.connectLocal(projectId, designId, organizationId, assertActive);
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
