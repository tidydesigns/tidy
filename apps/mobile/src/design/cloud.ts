import { z } from "zod";
import {
  applyDocumentPatch,
  documentPatchSchema,
  type DocumentPatch,
} from "@tidy/design/document-patch";
import { fileChangesSchema } from "@tidy/design/sync-protocol";
import { cloudAccountSchema, cloudCatalogSchema } from "@tidy/agent-protocol/contracts/cloud-sync";
import type { DesignDocument } from "@tidy/design/document";

export type Snapshot = {
  revision: number;
  content: DesignDocument;
  name: string;
  canEdit: boolean;
};
export type Upload = { operationId: string; base: Snapshot; patch: DocumentPatch };
export class CloudError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Sign in again to sync."
        : status === 403
          ? "You no longer have permission to edit this file."
          : status === 409
            ? "This file changed on another device."
            : status === 429
              ? "Sync will retry shortly."
              : `Cloud sync failed (${status}).`,
    );
  }
}
export interface CloudRemote {
  create(org: string, id: string, name: string): Promise<void>;
  read(id: string, base?: Snapshot): Promise<Snapshot>;
  commit(id: string, upload: Upload): Promise<Snapshot>;
  uploadAsset?(id: string, data: string): Promise<string>;
}
export class MobileCloud implements CloudRemote {
  constructor(readonly request: (path: string, init?: RequestInit) => Promise<Response>) {}
  private path(id: string) {
    return `/api/desktop/files/${z.uuid().parse(id)}`;
  }
  async account() {
    return cloudAccountSchema.parse(await (await this.request("/api/desktop/account")).json());
  }
  async catalog(org: string) {
    return cloudCatalogSchema.parse(
      await (
        await this.request(`/api/desktop/organizations/${encodeURIComponent(org)}/catalog`)
      ).json(),
    );
  }
  private post(path: string, value: unknown) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
  async create(org: string, id: string, name: string) {
    await this.post(`/api/desktop/organizations/${encodeURIComponent(org)}/files`, { id, name });
  }
  async read(id: string, base?: Snapshot): Promise<Snapshot> {
    const value = fileChangesSchema.parse(
      await (
        await this.request(`${this.path(id)}${base ? `?revision=${base.revision}` : ""}`)
      ).json(),
    );
    if ("snapshot" in value) return { ...value.snapshot, name: value.name, canEdit: value.canEdit };
    if (!base || value.baseRevision !== base.revision)
      throw new Error("Unexpected cloud revision.");
    let revision = base.revision,
      content = base.content;
    for (const patch of value.patches) {
      if (patch.baseRevision !== revision || patch.revision !== revision + 1)
        throw new Error("Cloud changes are incomplete.");
      content = applyDocumentPatch(content, patch.patch);
      revision = patch.revision;
    }
    if (revision !== value.revision) throw new Error("Cloud changes are incomplete.");
    return { revision, content, name: value.name, canEdit: value.canEdit };
  }
  async commit(id: string, upload: Upload): Promise<Snapshot> {
    const value = z
      .object({
        baseRevision: z.number().int(),
        revision: z.number().int(),
        patch: documentPatchSchema,
      })
      .parse(
        await (
          await this.post(this.path(id), {
            operationId: upload.operationId,
            baseRevision: upload.base.revision,
            patch: upload.patch,
          })
        ).json(),
      );
    if (value.baseRevision !== upload.base.revision || value.revision !== value.baseRevision + 1)
      throw new Error("Unexpected cloud revision.");
    return {
      ...upload.base,
      revision: value.revision,
      content: applyDocumentPatch(upload.base.content, value.patch),
    };
  }
  async asset(file: string, id: string) {
    const value = z
      .object({
        id: z.uuid(),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
        base64: z.string().max(2_800_000),
      })
      .parse(
        await (await this.request(`${this.path(file)}/assets?id=${z.uuid().parse(id)}`)).json(),
      );
    if (value.id !== id) throw new Error("Unexpected image.");
    return `data:${value.mimeType};base64,${value.base64}`;
  }
  async uploadAsset(id: string, data: string) {
    const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match || match[2].length > 2_800_000) throw new Error("This image cannot be synced.");
    return z
      .object({ assetId: z.uuid() })
      .parse(
        await (
          await this.post(`${this.path(id)}/assets`, { mimeType: match[1], base64: match[2] })
        ).json(),
      ).assetId;
  }
}
