import { ExpiredDocumentEdit } from "@/lib/design/history-retention";
import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { getDesignFile } from "@/lib/design/service";
import { can } from "@/lib/organizations/roles";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { readFileChanges } from "@/lib/design/changes";
import { commitDocumentPatch } from "@/lib/design/commands";
import { documentPatchSchema } from "@/lib/design/document-patch";
import { realtimeSchemaReady } from "@/lib/realtime/server";

export const runtime = "nodejs";
const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    patch: documentPatchSchema,
    conditional: z.boolean().default(false),
    sourceNodeId: z.string().min(1).max(120).optional(),
    baseRevision: z.number().int().min(0).max(2147483647),
    expectedSequence: z.number().int().min(0).optional(),
    allowedSequences: z.array(z.number().int().min(0)).max(50000).optional(),
  })
  .strict();
export async function GET(request: Request, { params }: RouteContext<"/api/files/[uid]/changes">) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  if (!(await realtimeSchemaReady()))
    return Response.json(
      { error: "Live files require the multiplayer migration." },
      { status: 503 },
    );
  const requestedRevision = new URL(request.url).searchParams.get("revision");
  const revision = requestedRevision === null ? null : Number(requestedRevision);
  if (
    revision !== null &&
    (!/^\d+$/.test(requestedRevision!) ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision > 2147483647)
  )
    return new Response(null, { status: 400 });
  const row = await readFileChanges(session.user.id, uid, revision);
  if (!row) return new Response(null, { status: 404 });
  return Response.json(
    {
      canEdit: can(row.role, "edit"),
      name: row.name,
      ...(row.patches
        ? { baseRevision: revision, revision: row.revision, patches: row.patches }
        : { snapshot: { revision: row.revision, content: row.content } }),
      sequence: Number(row.sequence),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
export async function POST(request: Request, { params }: RouteContext<"/api/files/[uid]/changes">) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  const file = await getDesignFile(session.user.id, uid);
  if (!file) return new Response(null, { status: 404 });
  if (!can(file.role, "edit"))
    return Response.json(
      { error: "Editor access is required to change this design." },
      { status: 403 },
    );
  if (!(await realtimeSchemaReady()))
    return Response.json(
      { error: "Live files require the multiplayer migration." },
      { status: 503 },
    );
  try {
    const input = inputSchema.parse(await (await boundedRequest(request, 2_000_000)).json());
    const result = await commitDocumentPatch(
      session.user.id,
      uid,
      input.operationId,
      input.baseRevision,
      input.patch,
      input.conditional,
      input.sourceNodeId,
      input.expectedSequence,
      input.allowedSequences,
    );
    const delta =
      result.patch.length > 0 &&
      result.baseRevision === input.baseRevision &&
      result.committedRevision === result.snapshot.revision;
    const response = delta
      ? {
          patch: result.patch,
          baseRevision: result.baseRevision,
          revision: result.snapshot.revision,
          sequence: result.sequence,
        }
      : { patch: result.patch, snapshot: result.snapshot, sequence: result.sequence };
    return Response.json(response, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ExpiredDocumentEdit)
      return Response.json(
        { error: error.message, code: "EDIT_EXPIRED" },
        { status: 410, headers: { "Cache-Control": "private, no-store" } },
      );
    if (error instanceof RequestBodyError) return requestBodyError(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not apply edit." },
      { status: 409 },
    );
  }
}
