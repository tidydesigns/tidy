import type { CloudAPI, CloudState } from "../shared/cloud-sync";
import { CloudAuth } from "./cloud-auth";
import { CloudSync } from "./cloud-sync";
import { HTTPCloudRemote } from "./cloud-remote";
import { PrivateState } from "./private-state";
import { WorkspaceService } from "./workspace-service";

/** Own the optional account connection separately from local workspace availability. */
export class CloudService implements CloudAPI {
  readonly sync: CloudSync;
  private remote: HTTPCloudRemote;
  private listeners = new Set<(state: CloudState) => void>();
  private unsubscribe: () => void;
  private action = Promise.resolve();
  private enabled = true;
  private initialization?: Promise<void>;
  private initialized = false;
  private closed = false;
  private generation = 0;
  private designVersions = new Map<string, string>();
  constructor(
    private auth: CloudAuth,
    private service: WorkspaceService,
    private privateState: PrivateState,
  ) {
    this.remote = new HTTPCloudRemote(auth);
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
  async account() {
    return this.remote.account();
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
