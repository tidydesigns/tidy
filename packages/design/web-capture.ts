import { nodeAssetIds } from "./document";
import * as z from "zod";
import { designDocumentSchema, parseDesignDocument } from "./document";

export { MAX_CAPTURE_BYTES } from "./capture-source";
export const webCaptureSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    // Do not import query strings or fragments, which can contain credentials.
    url: z
      .url()
      .max(2000)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "Capture source must be an HTTP(S) URL without credentials, a query, or a fragment."),
    mode: z.enum(["page", "element"]),
    document: designDocumentSchema,
    assets: z
      .array(
        z
          .object({
            id: z.uuid(),
            mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            base64: z
              .string()
              .min(1)
              .max(2_800_000)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((capture, ctx) => {
    try {
      parseDesignDocument(capture.document);
    } catch {
      ctx.addIssue({ code: "custom", message: "Capture has an invalid design tree." });
    }
    const ids = new Set(capture.assets.map((asset) => asset.id));
    if (ids.size !== capture.assets.length)
      ctx.addIssue({ code: "custom", message: "Duplicate capture asset." });
    for (const node of capture.document.nodes) {
      if (nodeAssetIds(node).some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Capture asset is missing." });
    }
    if (!capture.document.nodes.some((node) => node.type === "artboard"))
      ctx.addIssue({ code: "custom", message: "Capture needs a frame." });
  });

export type WebCapture = z.infer<typeof webCaptureSchema>;

export const webImportSchema = z
  .object({
    userId: z.string().min(1).max(120),
    organizationId: z.string().min(1).max(120),
    fileId: z.uuid().optional(),
    capture: webCaptureSchema,
  })
  .strict();

export type ExtensionAccount = {
  user: { id: string; name: string };
  organizations: { id: string; name: string; files: { id: string; name: string }[] }[];
};
export type ImportResult = {
  fileId: string;
  url: string;
  revision: number;
  warnings?: { message: string }[];
};

export { captureSourceUrl } from "./capture-source";
