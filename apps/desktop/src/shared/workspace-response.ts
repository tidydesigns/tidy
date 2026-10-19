import { z } from "zod";
import { designDocumentSchema } from "@tidy/design/document";
import { attachmentSchema } from "./attachments";
import { liveThreadSchema, threadSummarySchema } from "./thread-schema";

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  openedAt: z.string(),
});
const folderSchema = z.object({ id: z.string().uuid(), name: z.string(), updatedAt: z.string() });
const designSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  updatedAt: z.string(),
  folderId: z.string().uuid().nullable().optional(),
  nodeCount: z.number().optional(),
});
const localDesignSchema = designSchema.extend({
  document: designDocumentSchema,
  version: z.string(),
  assets: z.record(z.string(), z.string()),
});
const projectSnapshotSchema = z.object({
  project: projectSchema,
  threads: z.array(threadSummarySchema),
  designs: z.array(designSchema),
  folders: z.array(folderSchema),
});
const connectionsSchema = z.array(
  z.object({
    id: z.enum(["codex", "claude"]),
    name: z.string(),
    status: z.enum(["ready", "signed-out", "not-installed"]),
  }),
);
const detailsSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      efforts: z.array(z.string()),
      defaultEffort: z.string().optional(),
    }),
  ),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  windows: z.array(
    z.object({
      name: z.string(),
      usedPercent: z.number(),
      resetsAt: z.number().optional(),
      windowMinutes: z.number().optional(),
    }),
  ),
  usageError: z.string().optional(),
  updatedAt: z.string(),
  usagePage: z.enum(["subscription", "api"]),
});
const attachedFileSchema = attachmentSchema.extend({ previewUrl: z.string().optional() });
const responseSchemas = {
  bootstrap: z.object({
    projects: z.array(projectSchema),
    activeProject: projectSnapshotSchema.nullable(),
    harnesses: connectionsSchema,
  }),
  "open-project": projectSnapshotSchema.nullable(),
  "select-project": projectSnapshotSchema,
  "project-snapshot": projectSnapshotSchema,
  harnesses: connectionsSchema,
  "harness-details": detailsSchema,
  "harness-usage-page": z.void(),
  "thread-settings": liveThreadSchema,
  "read-thread": liveThreadSchema,
  "start-thread": liveThreadSchema,
  "send-message": liveThreadSchema,
  "set-thread-done": liveThreadSchema,
  "respond-approval": liveThreadSchema,
  "stop-thread": z.void(),
  "add-attachment": attachedFileSchema,
  "read-attachment": attachedFileSchema,
  "create-design": localDesignSchema,
  "import-design": localDesignSchema.nullable(),
  "read-design": localDesignSchema,
  "update-design": localDesignSchema,
  "create-design-folder": folderSchema,
  "rename-design-folder": folderSchema,
  "upload-design-asset": z.object({ assetId: z.string(), url: z.string() }),
};
export type WorkspaceOperation = keyof typeof responseSchemas;
export type WorkspaceResponse<Name extends WorkspaceOperation> = z.output<
  (typeof responseSchemas)[Name]
>;
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export function parseWorkspaceResponse<Name extends WorkspaceOperation>(
  name: Name,
  value: unknown,
): WorkspaceResponse<Name> {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error("Invalid desktop response.");
  if (!envelope.data.ok) throw new Error(envelope.data.error);
  const result = responseSchemas[name].safeParse(envelope.data.data);
  if (!result.success) throw new Error("Invalid desktop response.");
  return result.data as WorkspaceResponse<Name>;
}
