import { z } from "zod";

export const cloudAccountSchema = z.object({
  id: z.string().min(1).max(2048),
  organizations: z
    .array(z.object({ id: z.string(), name: z.string(), canEdit: z.boolean() }))
    .max(1000),
});
export const cloudFilesSchema = z.array(
  z.object({ id: z.uuid(), name: z.string(), folderId: z.string().nullable() }),
);
export const cloudStateSchema = z.object({
  available: z.boolean(),
  signedIn: z.boolean(),
  accountId: z.string().optional(),
  bindings: z.array(
    z.object({
      projectId: z.uuid(),
      designId: z.uuid(),
      fileId: z.uuid(),
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
  account(): Promise<CloudAccount>;
  files(organizationId: string): Promise<CloudFile[]>;
  open(projectId: string, fileId: string, name: string): Promise<void>;
  connectLocal(projectId: string, designId: string, organizationId: string): Promise<void>;
  disconnect(projectId: string, designId: string): Promise<void>;
  onState(listener: (state: CloudState) => void): () => void;
};
