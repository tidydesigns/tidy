import { z } from "zod";
import type { ProjectSnapshot } from "./contracts";
import { localDesignSchema } from "./workspace-response";

export const cloudAccountSchema = z.object({
  id: z.string().min(1).max(2048),
  organizations: z
    .array(z.object({ id: z.string(), name: z.string(), canEdit: z.boolean() }))
    .max(1000),
});
export const cloudFilesSchema = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    folderId: z.string().nullable(),
    updatedAt: z.string().optional(),
    createdAt: z.string().optional(),
    creatorId: z.string().max(2048).optional(),
    creatorName: z.string().optional(),
    creatorImage: z.string().max(2048).nullable().optional(),
  }),
);
export const cloudCatalogSchema = z.object({
  files: cloudFilesSchema,
  folders: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const cloudManifestSchema = z
  .array(
    z.object({
      fileId: z.uuid(),
      revision: z.number().int().nonnegative(),
      name: z.string().max(120),
      canEdit: z.boolean(),
    }),
  )
  .max(1000);
export type CloudManifest = z.infer<typeof cloudManifestSchema>;
export const cloudOpenedSchema = z.object({ projectId: z.uuid(), design: localDesignSchema });
export type CloudCatalog = z.infer<typeof cloudCatalogSchema>;
export type CloudOpened = z.infer<typeof cloudOpenedSchema>;
export const cloudAvatarSchema = z
  .string()
  .max(6_666_720)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
  .nullable();
export const cloudThumbnailSchema = z
  .string()
  .max(2_800_050)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  .nullable();
export const cloudStateSchema = z.object({
  available: z.boolean(),
  signedIn: z.boolean(),
  accountId: z.string().optional(),
  bindings: z.array(
    z.object({
      projectId: z.uuid(),
      designId: z.uuid(),
      fileId: z.uuid(),
      organizationId: z.string().optional(),
      status: z.enum(["synced", "syncing", "offline", "conflict", "paused"]),
      message: z.string().optional(),
    }),
  ),
});
export type CloudState = z.infer<typeof cloudStateSchema>;
export type CloudAccount = z.infer<typeof cloudAccountSchema>;
export type CloudFile = z.infer<typeof cloudFilesSchema>[number];

export type CloudAPI = {
  state(): Promise<CloudState>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  account(cachedOnly?: boolean): Promise<CloudAccount>;
  openWorkspace(organizationId: string): Promise<ProjectSnapshot>;
  catalog(organizationId: string, cachedOnly?: boolean): Promise<CloudCatalog>;
  openFile(organizationId: string, fileId: string): Promise<CloudOpened>;
  createFile(organizationId: string): Promise<CloudOpened>;
  keepBoth(organizationId: string, projectId: string, designId: string): Promise<CloudOpened>;
  focus(projectId?: string, designId?: string): Promise<void>;
  thumbnail(fileId: string, version: string): Promise<string | null>;
  creatorAvatar(fileId: string, creatorId: string, version: string): Promise<string | null>;
  files(organizationId: string): Promise<CloudFile[]>;
  open(projectId: string, fileId: string, name: string): Promise<void>;
  connectLocal(projectId: string, designId: string, organizationId: string): Promise<void>;
  disconnect(projectId: string, designId: string): Promise<void>;
  onState(listener: (state: CloudState) => void): () => void;
};
