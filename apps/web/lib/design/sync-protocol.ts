import { z } from "zod";
import { parseImmutableDesignDocument } from "./document";
import { documentPatchSchema } from "./document-patch";

const revision = z.number().int().nonnegative();
export const roomSnapshotSchema = z.object({
  revision,
  // Retain the editor's frozen document identity and semantic document validation.
  content: z.unknown().transform((value, context) => {
    try {
      return parseImmutableDesignDocument(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid design document." });
      return z.NEVER;
    }
  }),
});
const snapshot = roomSnapshotSchema;
export const snapshotCommitSchema = z.object({
  snapshot,
  patch: documentPatchSchema,
  sequence: revision,
});
const delta = z.object({ baseRevision: revision, revision });
export const fileChangesSchema = z
  .union([
    z.object({ snapshot }),
    delta.extend({ patches: z.array(delta.extend({ patch: documentPatchSchema })) }),
  ])
  .and(z.object({ name: z.string(), sequence: revision, canEdit: z.boolean() }));
export const fileCommitSchema = z
  .union([z.object({ snapshot }), delta])
  .and(z.object({ patch: documentPatchSchema, sequence: revision }));
export const presenceTicketSchema = z.object({
  url: z.url().refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol)),
  expiresAt: z.number().int().nonnegative(),
  sessionId: z.uuid(),
});
