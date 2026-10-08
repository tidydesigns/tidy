import { z } from "zod";
import { getDesignFile } from "@/lib/design/service";
import { can } from "@/lib/organizations/roles";
import { commitDocumentPatch } from "@/lib/design/commands";
import { VersionError } from "@/lib/design/file-versions";
import {
  versionUser,
  versionBody,
  versionFailure,
  versionHeaders,
} from "@/lib/design/file-version-http";
export const runtime = "nodejs";
const restoration = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().min(0).max(2147483647),
  })
  .strict();
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/history/[versionId]/restore">,
) {
  try {
    const user = await versionUser(request, true),
      { uid, versionId } = await params;
    const file = await getDesignFile(user, uid);
    if (!file) throw new VersionError("File not found or access denied.", 404);
    if (!can(file.role, "edit"))
      throw new VersionError("Editor access is required to restore a version.", 403);
    z.string().uuid().parse(versionId);
    const input = restoration.parse(await versionBody(request));
    try {
      const result = await commitDocumentPatch(
        user,
        uid,
        input.operationId,
        input.expectedRevision,
        [],
        false,
        undefined,
        undefined,
        undefined,
        { versionId, expectedRevision: input.expectedRevision },
      );
      return Response.json(result, { headers: versionHeaders });
    } catch (error) {
      throw new VersionError(
        error instanceof Error ? error.message : "Could not restore this version.",
        409,
      );
    }
  } catch (error) {
    return versionFailure(error);
  }
}
