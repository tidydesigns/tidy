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
} from "./contracts";
import { harnessDetailsSchema } from "./harness-settings";

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
const attachedFileSchema = attachmentSchema.extend({ previewUrl: z.string().optional() });
const responseSchemas = {
  bootstrap: z.object({
    projects: z.array(projectSchema),
    activeProject: projectSnapshotSchema.nullable(),
    harnesses: z.array(harnessConnectionSchema),
  }),
  "open-project": projectSnapshotSchema.nullable(),
  "select-project": projectSnapshotSchema,
  "project-snapshot": projectSnapshotSchema,
  harnesses: z.array(harnessConnectionSchema),
  "harness-details": harnessDetailsSchema,
  "harness-usage-page": z.void(),
  "thread-settings": liveThreadSchema,
  "read-thread": liveThreadSchema,
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
