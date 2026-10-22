import { z } from "zod";
import { parseDesignDocument, type DesignDocument } from "@tidy/design/document";
import {
  applyDocumentPatch,
  documentPatchSchema,
  type DocumentPatch,
} from "@tidy/editor/design/document-patch";
import { fileChangesSchema } from "@tidy/editor/design/sync-protocol";
import { CloudAuth, CloudHTTPError } from "./cloud-auth";
import { cloudAccountSchema, cloudFilesSchema } from "../shared/cloud-sync";

export type CloudSnapshot = { revision: number; content: DesignDocument };
export type PendingUpload = { operationId: string; base: CloudSnapshot; patch: DocumentPatch };
export interface CloudRemote {
  create(organizationId: string, fileId: string, name: string, signal?: AbortSignal): Promise<void>;
  read(fileId: string, base?: CloudSnapshot, signal?: AbortSignal): Promise<CloudSnapshot>;
  commit(fileId: string, pending: PendingUpload, signal?: AbortSignal): Promise<CloudSnapshot>;
  downloadAsset(fileId: string, assetId: string, signal?: AbortSignal): Promise<string>;
  uploadAsset(fileId: string, dataUrl: string, signal?: AbortSignal): Promise<string>;
}

export class HTTPCloudRemote implements CloudRemote {
  constructor(readonly auth: CloudAuth) {}
  private path(fileId: string) {
    return `/api/desktop/files/${z.uuid().parse(fileId)}`;
  }
  async account() {
    return cloudAccountSchema.parse(await (await this.auth.request("/api/desktop/account")).json());
  }
  async files(organizationId: string) {
    return cloudFilesSchema.parse(
      await (
        await this.auth.request(
          `/api/desktop/organizations/${encodeURIComponent(organizationId)}/files`,
        )
      ).json(),
    );
  }
  async create(organizationId: string, fileId: string, name: string, signal?: AbortSignal) {
    await this.auth.request(
      `/api/desktop/organizations/${encodeURIComponent(organizationId)}/files`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: fileId, name }),
      },
    );
  }
  async read(fileId: string, base?: CloudSnapshot, signal?: AbortSignal) {
    const value = fileChangesSchema.parse(
      await (
        await this.auth.request(`${this.path(fileId)}${base ? `?revision=${base.revision}` : ""}`, {
          signal,
        })
      ).json(),
    );
    if (!value.canEdit) throw new CloudHTTPError(403);
    if ("snapshot" in value) return value.snapshot;
    if (!base || value.baseRevision !== base.revision) throw new Error("Invalid cloud revision.");
    let snapshot = base;
    for (const entry of value.patches) {
      if (entry.baseRevision !== snapshot.revision || entry.revision !== snapshot.revision + 1)
        throw new Error("Invalid cloud change sequence.");
      snapshot = {
        revision: entry.revision,
        content: applyDocumentPatch(snapshot.content, entry.patch, false),
      };
    }
    if (snapshot.revision !== value.revision) throw new Error("Incomplete cloud changes.");
    return snapshot;
  }
  async commit(fileId: string, pending: PendingUpload, signal?: AbortSignal) {
    const receipt = z
      .object({
        baseRevision: z.number().int().nonnegative(),
        revision: z.number().int().nonnegative(),
        patch: documentPatchSchema,
      })
      .parse(
        await (
          await this.auth.request(this.path(fileId), {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId: pending.operationId,
              baseRevision: pending.base.revision,
              patch: pending.patch,
            }),
          })
        ).json(),
      );
    if (
      receipt.baseRevision !== pending.base.revision ||
      receipt.revision !== receipt.baseRevision + 1
    )
      throw new Error("Invalid cloud acknowledgement.");
    return {
      revision: receipt.revision,
      content: parseDesignDocument(applyDocumentPatch(pending.base.content, receipt.patch, false)),
    };
  }
  async downloadAsset(fileId: string, assetId: string, signal?: AbortSignal) {
    const asset = z
      .object({
        id: z.uuid(),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
        base64: z.string().max(2_800_000),
      })
      .parse(
        await (
          await this.auth.request(`${this.path(fileId)}/assets?id=${z.uuid().parse(assetId)}`, {
            signal,
          })
        ).json(),
      );
    if (asset.id !== assetId) throw new Error("Invalid cloud image.");
    return `data:${asset.mimeType};base64,${asset.base64}`;
  }
  async uploadAsset(fileId: string, dataUrl: string, signal?: AbortSignal) {
    const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl,
    );
    if (!match) throw new Error("This local image cannot be synced.");
    return z.object({ assetId: z.uuid() }).parse(
      await (
        await this.auth.request(`${this.path(fileId)}/assets`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mimeType: match[1], base64: match[2] }),
        })
      ).json(),
    ).assetId;
  }
}
