import { createHash } from "node:crypto";
import { extensionImportSchema } from "@tidy/design/web-capture";
import { importWebCapture } from "@/lib/design/web-capture-service";
import { CaptureBodyError } from "./http";

export async function submitCapture(userId: string, body: unknown) {
  const { request, ...input } = extensionImportSchema.parse(body);
  // Fixed client timestamp prevents a legitimate retry recreating a deleted receipt
  // after its 24-hour retention. Never silently allocate a fresh submission ID.
  const age = Date.now() - request.createdAt;
  if (age < -5 * 60_000 || age >= 24 * 60 * 60_000)
    throw new CaptureBodyError("This capture request expired. Start a new capture.");
  const hash = createHash("sha256")
    .update(JSON.stringify({ request, ...input }))
    .digest("hex");
  return importWebCapture(userId, input, undefined, undefined, {
    id: request.id,
    hash,
    createdAt: request.createdAt,
  });
}
