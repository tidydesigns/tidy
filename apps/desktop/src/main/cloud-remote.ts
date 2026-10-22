import { z } from "zod";
import { parseDesignDocument, type DesignDocument } from "@tidy/design/document";
import {
  applyDocumentPatch,
  documentPatchSchema,
  type DocumentPatch,
} from "@tidy/editor/design/document-patch";
import { fileChangesSchema } from "@tidy/editor/design/sync-protocol";
import { CloudAuth, CloudHTTPError } from "./cloud-auth";
import { cloudAccountSchema, cloudFilesSchema, cloudCatalogSchema } from "../shared/cloud-sync";

export type CloudSnapshot = { revision: number; content: DesignDocument; name?: string };
export type PendingUpload = { operationId: string; base: CloudSnapshot; patch: DocumentPatch };
export interface CloudRemote {
  rename?(fileId: string, before: string, name: string, signal?: AbortSignal): Promise<void>;
  create(organizationId: string, fileId: string, name: string, signal?: AbortSignal): Promise<void>;
  read(fileId: string, base?: CloudSnapshot, signal?: AbortSignal): Promise<CloudSnapshot>;
  commit(fileId: string, pending: PendingUpload, signal?: AbortSignal): Promise<CloudSnapshot>;
  downloadAsset(fileId: string, assetId: string, signal?: AbortSignal): Promise<string>;
  uploadAsset(fileId: string, dataUrl: string, signal?: AbortSignal): Promise<string>;
}

export class HTTPCloudRemote implements CloudRemote {
  constructor(readonly auth: CloudAuth) {}
  async rename(fileId: string, before: string, name: string, signal?: AbortSignal) {
    await this.auth.request(`${this.path(fileId)}/name`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ before, name }),
    });
  }
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
  async catalog(organizationId: string) {
    return cloudCatalogSchema.parse(
      await (
        await this.auth.request(
          `/api/desktop/organizations/${encodeURIComponent(organizationId)}/catalog`,
        )
      ).json(),
    );
  }
  async thumbnail(fileId: string) {
    let response: Response;
    try {
      response = await this.auth.request(`${this.path(fileId)}/thumbnail`);
    } catch (cause) {
      if (cause instanceof CloudHTTPError && cause.status === 404) return null;
      throw cause;
    }
    if (response.headers.get("content-type")?.split(";")[0] !== "image/png") return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2_000_000) throw new Error("Thumbnail is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const image = Buffer.concat(chunks);
    if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
    return `data:image/png;base64,${image.toString("base64")}`;
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
    if ("snapshot" in value) return { ...value.snapshot, name: value.name };
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
    return { ...snapshot, name: value.name };
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
