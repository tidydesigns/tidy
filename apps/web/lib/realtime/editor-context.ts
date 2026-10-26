import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signTicket } from "./ticket";
import { withDeadline } from "@/lib/deadline";
import { PublicActionError } from "@/lib/security/public-error";
import { editorExportResultSchema, type EditorExportRequest } from "./protocol";
import * as z from "zod";
const contextSchema = z
  .array(
    z.object({
      sessionId: z.uuid(),
      pageId: z.string().min(1).max(120),
      selectedIds: z.array(z.string().min(1).max(120)).max(100),
      viewport: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          zoom: z.number().positive(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .nullable(),
      updatedAt: z.number().int(),
    }),
  )
  .max(3);
export async function readEditorContext(userId: string, fileId: string) {
  let context;
  try {
    context = getCloudflareContext();
  } catch {}
  try {
    if (context?.env.FILE_ROOMS)
      return {
        available: true,
        sessions: contextSchema.parse(
          await withDeadline(
            context.env.FILE_ROOMS.getByName(fileId).editorContext(fileId, userId),
            3000,
            "Editor context timed out.",
          ),
        ),
      };
    if (!process.env.BELLA_REALTIME_URL || !process.env.BETTER_AUTH_SECRET)
      return { available: false, sessions: [] };
    const response = await editorRelay(userId, fileId, { action: "context" });
    return { available: true, sessions: contextSchema.parse(await response.json()) };
  } catch {
    return { available: false, sessions: [] };
  }
}
export async function requestEditorExport(
  userId: string,
  fileId: string,
  request: EditorExportRequest,
  sessionId?: string,
) {
  let context;
  try {
    context = getCloudflareContext();
  } catch {}
  try {
    if (context?.env.FILE_ROOMS)
      return editorExportResultSchema.parse(
        await withDeadline(
          context.env.FILE_ROOMS.getByName(fileId).exportSelection(
            fileId,
            userId,
            request,
            sessionId,
          ),
          17000,
          "Editor export timed out.",
        ),
      );
    if (process.env.BELLA_REALTIME_URL && process.env.BETTER_AUTH_SECRET)
      return editorExportResultSchema.parse(
        await (await editorRelay(userId, fileId, { action: "export", request, sessionId })).json(),
      );
  } catch {
    throw new PublicActionError(
      "Could not export. Keep the target page open in your editor, synchronize it, and try a smaller selection.",
    );
  }
  throw new PublicActionError(
    "Open this file in a connected Tidy editor to export PNG, WebP, SVG or PDF.",
  );
}
async function editorRelay(userId: string, fileId: string, body: object) {
  const ticket = await signTicket(
    {
      purpose: "file-room",
      fileId,
      organizationId: "internal",
      userId,
      name: "",
      image: null,
      sessionId: crypto.randomUUID(),
      authSessionId: "editor-bridge",
      expiresAt: Date.now() + 30000,
    },
    process.env.BETTER_AUTH_SECRET!,
  );
  const response = await fetch(new URL("/__editor", process.env.BELLA_REALTIME_URL!), {
    method: "POST",
    headers: { Authorization: `Bearer ${ticket}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(17000),
  });
  if (!response.ok) throw new Error("Editor relay unavailable.");
  return response;
}
