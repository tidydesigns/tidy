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

export const extensionAccountSchema = z.object({
  user: z.object({ id: z.string().min(1), name: z.string(), image: z.string().nullish() }),
  organizations: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      files: z.array(z.object({ id: z.string().min(1), name: z.string() })),
    }),
  ),
});
export type ExtensionAccount = z.infer<typeof extensionAccountSchema>;
export const importResultSchema = z.object({
  fileId: z.string().min(1),
  url: z.string(),
  revision: z.number().int().positive(),
  nodeIds: z.array(z.string()).optional(),
  warnings: z.array(z.object({ message: z.string() })).optional(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const destinationSchema = z.object({
  organizationId: z.string().min(1),
  fileId: z.string().optional(),
  userId: z.string().min(1),
});
const jobIdentity = { userId: z.string().min(1), tabId: z.number().int().nonnegative() };
const captureJob = {
  ...jobIdentity,
  documentId: z.string().min(1),
  destination: destinationSchema,
};
export const importJobSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("selecting"), ...captureJob }),
  z.object({ state: z.literal("importing"), ...captureJob }),
  z.object({
    state: z.literal("done"),
    ...jobIdentity,
    url: z.string().url(),
    warnings: z.array(z.object({ message: z.string() })).optional(),
  }),
  z.object({ state: z.literal("error"), ...jobIdentity, error: z.string() }),
]);
export type ImportJob = z.infer<typeof importJobSchema>;
export type Destination = z.infer<typeof destinationSchema>;
/** Incomplete old jobs cannot be resumed safely; the previous import may have committed. */
export function readImportJob(value: unknown): ImportJob | undefined {
  if (value === undefined) return undefined;
  const parsed = importJobSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const identity = z.object(jobIdentity).safeParse(value);
  if (!identity.success) return undefined;
  return {
    ...identity.data,
    state: "error",
    error: "The import was interrupted. Check the destination file before copying again.",
  };
}

export { captureSourceUrl } from "./capture-source";

export const captureViewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
});
export function readExtensionReply(value: unknown): unknown {
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success) throw new Error(error.data.error);
  const input = z.object({ data: z.unknown() }).safeParse(value);
  if (!input.success || !("data" in input.data))
    throw new Error("The page could not complete the capture. Reopen the extension and try again.");
  return input.data.data;
}
export function parseExtensionResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const input = schema.safeParse(value);
  if (!input.success)
    throw new Error(
      "Tidy returned an unsupported response. Check the destination before trying again.",
    );
  return input.data;
}

export const extensionMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bella:account") }),
  z.object({ type: z.literal("bella:login") }),
  z.object({ type: z.literal("bella:cancel") }),
  z.object({ type: z.literal("bella:picked") }),
  z.object({ type: z.literal("bella:cancelled") }),
  z.object({
    type: z.literal("bella:start"),
    mode: z.enum(["page", "element"]),
    destination: destinationSchema,
  }),
]);
