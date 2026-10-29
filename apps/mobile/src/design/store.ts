import { z } from "zod";
import {
  blankDesignDocument,
  documentAssetIds,
  parseDesignDocument,
  parseImmutableDesignDocument,
  type DesignDocument,
} from "@tidy/design/document";
import { applyDocumentPatch, diffDocument, documentPatchSchema } from "@tidy/design/document-patch";
import { CloudError, type CloudRemote, type Snapshot } from "./cloud";

const document = z.unknown().transform((value) => parseImmutableDesignDocument(value));
const snapshot = z.object({
  revision: z.number().int().nonnegative(),
  content: document,
  name: z.string(),
  canEdit: z.boolean(),
});
const owner = z.object({ origin: z.string(), accountId: z.string(), organizationId: z.string() });
const recordSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  document,
  updatedAt: z.number(),
  assets: z.record(z.string(), z.string()),
  uploadedAssets: z.record(z.string(), z.string()).optional(),
  cloud: owner.extend({ fileId: z.uuid() }).optional(),
  creating: z.boolean().optional(),
  base: snapshot.optional(),
  conflict: snapshot.optional(),
  pending: z
    .object({ operationId: z.uuid(), base: snapshot, patch: documentPatchSchema, local: document })
    .optional(),
});
export type DesignFile = z.infer<typeof recordSchema>;
export type CloudOwner = z.infer<typeof owner>;
export type Storage = {
  read(): Promise<string[]>;
  write(id: string, value: string): Promise<void>;
};
const sameAccount = (
  a: { origin: string; accountId: string },
  b: { origin: string; accountId: string },
) => a.origin === b.origin && a.accountId === b.accountId;

/** The journal is written before any remote mutation, including its idempotency key. */
export class DesignStore {
  files = new Map<string, DesignFile>();
  messages = new Map<string, string>();
  syncing = new Set<string>();
  private writes = new Map<string, Promise<void>>();
  private durable = new Map<string, DesignFile>();
  private dirtyCache = new WeakMap<DesignFile, boolean>();
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  private session?: { origin: string; accountId: string; remote: CloudRemote };
  constructor(
    private storage: Storage,
    private uuid: () => string,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  async restore() {
    for (const value of await this.storage.read()) {
      const file = recordSchema.parse(JSON.parse(value));
      this.files.set(file.id, file);
      this.durable.set(file.id, file);
    }
    this.publish();
  }
  connect(session?: { origin: string; accountId: string; remote: CloudRemote }) {
    this.session = session;
    this.publish();
  }
  visible() {
    return [...this.files.values()]
      .filter((file) => !file.cloud || (this.session && sameAccount(file.cloud, this.session)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private put(file: DesignFile) {
    this.files.set(file.id, file);
    if (!this.writes.has(file.id)) {
      const write = Promise.resolve()
        .then(async () => {
          for (;;) {
            const current = this.files.get(file.id)!;
            await this.storage.write(file.id, JSON.stringify(current));
            this.durable.set(file.id, current);
            this.publish();
            if (this.files.get(file.id) === current) return;
          }
        })
        .finally(() => {
          this.writes.delete(file.id);
        });
      this.writes.set(file.id, write);
      void write.catch(() => {
        this.messages.set(
          file.id,
          "Could not store this edit on your phone. Keep the app open and retry sync.",
        );
        this.publish();
      });
    }
    this.publish();
    return file;
  }
  private async flush(id: string) {
    for (;;) {
      const current = this.files.get(id)!;
      if (this.durable.get(id) === current) return;
      if (!this.writes.has(id)) this.put(current);
      try {
        await this.writes.get(id);
      } catch {
        this.put(this.files.get(id)!);
        await this.writes.get(id);
      }
    }
  }
  create(
    name = "Untitled",
    cloud?: CloudOwner,
    content = blankDesignDocument(),
    assets: Record<string, string> = {},
  ) {
    const id = this.uuid();
    return this.put({
      id,
      name: name.trim().slice(0, 120) || "Untitled",
      document: parseImmutableDesignDocument(content),
      assets,
      updatedAt: Date.now(),
      ...(cloud ? { cloud: { ...cloud, fileId: this.uuid() }, creating: true } : {}),
    });
  }
  edit(id: string, content: DesignDocument) {
    const file = this.files.get(id);
    if (!file) return;
    if (file.base && !file.base.canEdit) throw new Error("This file is read-only.");
    this.put({ ...file, document: parseImmutableDesignDocument(content), updatedAt: Date.now() });
  }
  attach(id: string, cloud: CloudOwner) {
    const file = this.files.get(id)!;
    if (file.cloud) throw new Error("This file already belongs to a cloud workspace.");
    this.put({ ...file, cloud: { ...cloud, fileId: this.uuid() }, creating: true });
  }
  cached(owner: CloudOwner, fileId: string) {
    return [...this.files.values()].find(
      (file) => file.cloud && sameAccount(file.cloud, owner) && file.cloud.fileId === fileId,
    );
  }
  async open(owner: CloudOwner, fileId: string, remote: CloudRemote) {
    const existing = this.cached(owner, fileId);
    if (existing) return existing;
    const base = await remote.read(fileId);
    // Two taps can complete the same read in either order.
    return (
      this.cached(owner, fileId) ??
      this.put({
        id: this.uuid(),
        name: base.name,
        document: base.content,
        base,
        assets: {},
        cloud: { ...owner, fileId },
        updatedAt: Date.now(),
      })
    );
  }
  asset(id: string, assetId: string, data: string) {
    const file = this.files.get(id);
    if (file) this.put({ ...file, assets: { ...file.assets, [assetId]: data } });
  }
  async keepBoth(id: string) {
    const file = this.files.get(id)!;
    if (!file.conflict) return;
    if (documentAssetIds(file.document).some((assetId) => !file.assets[assetId]))
      throw new Error("Open this file online to download its images before keeping a copy.");
    // Retain account ownership on the copy, even if access has been revoked.
    const copy = this.create(
      `${file.name.slice(0, 108)} (phone copy)`,
      file.cloud,
      file.document,
      file.assets,
    );
    await this.flush(copy.id);
    this.useCloud(id);
    return copy;
  }
  useCloud(id: string) {
    const file = this.files.get(id)!;
    if (!file.conflict) return;
    this.put({
      ...file,
      name: file.conflict.name,
      document: file.conflict.content,
      base: file.conflict,
      conflict: undefined,
      pending: undefined,
    });
    this.messages.delete(id);
    this.publish();
  }
  private dirty(file: DesignFile) {
    let dirty = this.dirtyCache.get(file);
    if (dirty === undefined) {
      dirty =
        !file.base || !!file.pending || diffDocument(file.base.content, file.document).length > 0;
      this.dirtyCache.set(file, dirty);
    }
    return dirty;
  }
  status(file: DesignFile) {
    if (file.conflict) return "Needs review";
    if (this.messages.has(file.id)) return this.messages.get(file.id)!;
    if (this.syncing.has(file.id)) return "Syncing…";
    if (this.durable.get(file.id) !== file) return "Storing on phone…";
    if (!file.cloud) return "On this device";
    if (this.dirty(file)) return "On phone · waiting to sync";
    return file.base!.canEdit ? "Synced" : "Read-only";
  }
  sync(focus?: string) {
    if (this.running) return this.running;
    this.running = this.run(focus).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run(focus?: string) {
    const session = this.session;
    if (!session) return;
    for (const initial of this.visible()) {
      if (this.session !== session) return;
      if (!initial.cloud || initial.conflict) continue;
      if (
        initial.id !== focus &&
        !initial.creating &&
        !initial.pending &&
        initial.base &&
        !diffDocument(initial.base.content, initial.document).length
      )
        continue;
      const id = initial.id;
      this.syncing.add(id);
      this.publish();
      try {
        await this.flush(id);
        let file = this.files.get(id)!;
        const fileId = file.cloud!.fileId;
        if (file.creating) {
          await session.remote.create(file.cloud!.organizationId, fileId, file.name);
          if (this.session !== session) return;
          const base = await session.remote.read(fileId);
          if (this.session !== session) return;
          file = this.put({ ...this.files.get(id)!, creating: false, base });
          await this.flush(id);
        }
        // Retry an uncertain commit with exactly the persisted receipt before reading/rebasing.
        if (file.pending) {
          await this.commit(id, session);
          if (this.session !== session) return;
          file = this.files.get(id)!;
          if (file.conflict) continue;
        }
        const remote = await session.remote.read(fileId, file.base);
        if (this.session !== session) return;
        file = this.files.get(id)!;
        const changes = diffDocument(file.base!.content, file.document);
        if (
          !changes.length &&
          remote.revision === file.base!.revision &&
          remote.name === file.name &&
          remote.canEdit === file.base!.canEdit
        ) {
          this.messages.delete(id);
          continue;
        }
        let merged: DesignDocument;
        try {
          if (!remote.canEdit && changes.length) throw new Error("Read-only");
          merged = applyDocumentPatch(remote.content, changes, true);
        } catch {
          this.put({ ...file, conflict: remote });
          continue;
        }
        file = this.put({ ...file, base: remote, name: remote.name, document: merged });
        const patch = diffDocument(remote.content, merged);
        if (patch.length) {
          await this.prepareAssets(id, session);
          if (this.session !== session) return;
          file = this.files.get(id)!;
          this.put({
            ...file,
            pending: {
              operationId: this.uuid(),
              base: remote,
              patch: diffDocument(remote.content, file.document),
              local: file.document,
            },
          });
          await this.commit(id, session);
        }
        this.messages.delete(id);
      } catch (error) {
        this.messages.set(
          id,
          error instanceof Error ? error.message : "Offline · edits are stored on this phone.",
        );
      } finally {
        this.syncing.delete(id);
        this.publish();
      }
    }
  }
  private async prepareAssets(id: string, session: NonNullable<DesignStore["session"]>) {
    let file = this.files.get(id)!;
    const known = new Set([
      ...documentAssetIds(file.base!.content),
      ...Object.values(file.uploadedAssets ?? {}),
    ]);
    for (const assetId of documentAssetIds(file.document)) {
      if (known.has(assetId)) continue;
      const data = file.assets[assetId];
      if (!data || !session.remote.uploadAsset)
        throw new Error(
          "An image is missing. Open the original file online to download it before syncing the copy.",
        );
      const remoteId =
        file.uploadedAssets?.[assetId] ??
        (await session.remote.uploadAsset(file.cloud!.fileId, data));
      if (this.session !== session) return;
      file = this.files.get(id)!;
      const aliases = { ...file.uploadedAssets, [assetId]: remoteId };
      const remap = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(remap);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            key === "assetId" && typeof entry === "string"
              ? (aliases[entry] ?? entry)
              : remap(entry),
          ]),
        );
      };
      const content = parseDesignDocument(remap(file.document));
      if (content.assetMimeTypes)
        content.assetMimeTypes = Object.fromEntries(
          Object.entries(content.assetMimeTypes).map(([key, value]) => [
            aliases[key] ?? key,
            value,
          ]),
        );
      file = this.put({
        ...file,
        uploadedAssets: aliases,
        document: content,
        assets: { ...file.assets, [remoteId]: data },
      });
      await this.flush(id);
      known.add(remoteId);
    }
  }
  private async commit(id: string, session: NonNullable<DesignStore["session"]>) {
    await this.flush(id);
    if (this.session !== session) return;
    const file = this.files.get(id)!,
      pending = file.pending!;
    let base: Snapshot;
    try {
      base = await session.remote.commit(file.cloud!.fileId, pending);
    } catch (error) {
      if (this.session !== session) return;
      if (!(error instanceof CloudError) || error.status !== 409) throw error;
      const remote = await session.remote.read(file.cloud!.fileId);
      if (this.session !== session) return;
      // The old receipt is known to have failed. Rebase in the next sync pass.
      this.put({ ...this.files.get(id)!, pending: undefined, base: pending.base });
      try {
        const current = this.files.get(id)!;
        const content = applyDocumentPatch(
          remote.content,
          diffDocument(pending.base.content, current.document),
          true,
        );
        this.put({ ...current, base: remote, document: content });
      } catch {
        this.put({ ...this.files.get(id)!, conflict: remote });
      }
      return;
    }
    if (this.session !== session) return;
    const current = this.files.get(id)!;
    try {
      this.put({
        ...current,
        base,
        pending: undefined,
        document: applyDocumentPatch(
          base.content,
          diffDocument(pending.local, current.document),
          true,
        ),
      });
    } catch {
      this.put({ ...current, pending: undefined, conflict: base });
    }
    await this.flush(id);
  }
}
