import { z } from "zod";
import { designDocumentSchema } from "@tidy/design/document";
import { attachmentSchema, MAX_ATTACHMENTS } from "./attachments";

export const MAX_DRAFT_IMPORT_BYTES = 28_000_000;
export const draftImportSchema = z
  .object({
    projectId: z.string().uuid(),
    attachments: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            dataUrl: z.string().max(MAX_DRAFT_IMPORT_BYTES),
          })
          .strict(),
      )
      .max(MAX_ATTACHMENTS),
    designs: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            document: designDocumentSchema,
            assets: z
              .record(z.string().uuid(), z.string().max(3_000_000))
              .refine((assets) => Object.keys(assets).length <= 200),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.attachments.length * 2 +
        value.designs.length +
        value.designs.reduce((count, design) => count + Object.keys(design.assets).length, 0) <=
      1000,
    "There are too many images to move together. Remove some references and try again.",
  )
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_DRAFT_IMPORT_BYTES,
    "These references are too large to move together. Remove some references and try again.",
  );
export type DraftImport = z.infer<typeof draftImportSchema>;
export const draftImportResultSchema = z.object({
  attachments: z
    .array(attachmentSchema.extend({ previewUrl: z.string().optional() }))
    .max(MAX_ATTACHMENTS),
  designIds: z.array(z.string().uuid()).max(20),
});
export type DraftImportResult = z.infer<typeof draftImportResultSchema>;
