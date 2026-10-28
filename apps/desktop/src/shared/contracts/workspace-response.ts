import { draftImportResultSchema } from "./draft-import";
import { branchSwitchResultSchema, repositoryContextSchema } from "./repository-context";
import { projectCheckoutSchema, projectSetupIssueSchema } from "./project-setup";
import { directorySchema } from "./browser-directory";
import { skillCatalogSchema } from "./skills";
import { z } from "zod";
import { designDocumentSchema } from "@tidy/design/document";
import { attachmentSchema } from "./attachments";
import {
  liveThreadSchema,
  threadSummarySchema,
  projectSchema,
  folderSchema,
  designSchema,
  harnessConnectionSchema,
} from "./desktop";
import { harnessDetailsSchema } from "./harness-settings";

export const localDesignSchema = designSchema.extend({
  document: designDocumentSchema,
  version: z.string(),
  assets: z.record(z.string(), z.string()),
});
export const projectSnapshotSchema = z.object({
  project: projectSchema,
  threads: z.array(threadSummarySchema),
  designs: z.array(designSchema),
  folders: z.array(folderSchema),
});
export const projectSetupResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), snapshot: projectSnapshotSchema }),
  ...projectSetupIssueSchema.options,
]);
export type ProjectSetupResult = z.infer<typeof projectSetupResultSchema>;
const attachedFileSchema = attachmentSchema.extend({ previewUrl: z.string().optional() });
export const workspaceResponseSchemas = {
  "project-directories": directorySchema,
  "project-checkouts": z.array(projectCheckoutSchema),
  "setup-project": projectSetupResultSchema,
  "export-attachment": z.object({ name: z.string().max(200), dataUrl: z.string().max(28_000_000) }),
  "export-design": localDesignSchema,
  "import-draft": draftImportResultSchema.extend({ snapshot: projectSnapshotSchema }),
  bootstrap: z.object({
    projects: z.array(projectSchema),
    activeProject: projectSnapshotSchema.nullable(),
    harnesses: z.array(harnessConnectionSchema),
  }),
  "open-project": projectSnapshotSchema.nullable(),
  "select-project": projectSnapshotSchema,
  "remove-project": z.null(),
  "project-snapshot": projectSnapshotSchema,
  harnesses: z.array(harnessConnectionSchema),
  "repository-context": repositoryContextSchema,
  "switch-branch": branchSwitchResultSchema,
  "harness-details": harnessDetailsSchema,
  skills: skillCatalogSchema,
  "harness-usage-page": z.void(),
  "open-chat-link": z.void(),
  "thread-settings": liveThreadSchema,
  "read-thread": liveThreadSchema,
  "warm-thread": z.void(),
  "start-thread": liveThreadSchema,
  "send-message": liveThreadSchema,
  "message-queue": liveThreadSchema,
  "set-thread-done": liveThreadSchema,
  "respond-approval": liveThreadSchema,
  "stop-thread": z.void(),
  "add-attachment": attachedFileSchema,
  "read-attachment": attachedFileSchema,
  "create-design": localDesignSchema,
  "import-design": localDesignSchema.nullable(),
  "read-design": localDesignSchema,
  "preview-design": localDesignSchema,
  "refresh-design": localDesignSchema.nullable(),
  "update-design": localDesignSchema,
  "create-design-folder": folderSchema,
  "rename-design-folder": folderSchema,
  "upload-design-asset": z.object({ assetId: z.string(), url: z.string() }),
};
export const workspaceOperationSchema = z.object(workspaceResponseSchemas).keyof();
export type WorkspaceOperation = keyof typeof workspaceResponseSchemas;
export type WorkspaceResponse<Name extends WorkspaceOperation> = z.output<
  (typeof workspaceResponseSchemas)[Name]
>;
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export class WorkspaceRequestError extends Error {}

export function parseWorkspaceResponse<Name extends WorkspaceOperation>(
  name: Name,
  value: unknown,
): WorkspaceResponse<Name> {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error("Invalid desktop response.");
  if (!envelope.data.ok) throw new WorkspaceRequestError(envelope.data.error);
  const result = workspaceResponseSchemas[name].safeParse(envelope.data.data);
  if (!result.success) throw new Error("Invalid desktop response.");
  return result.data as WorkspaceResponse<Name>;
}
