import { z } from "zod";
import { readFileVersion } from "@/lib/design/file-versions";
import { versionUser, versionFailure, versionHeaders } from "@/lib/design/file-version-http";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/history/[versionId]">,
) {
  try {
    const user = await versionUser(request),
      { uid, versionId } = await params;
    z.string().uuid().parse(versionId);
    return Response.json(await readFileVersion(user, uid, versionId), { headers: versionHeaders });
  } catch (error) {
    return versionFailure(error);
  }
}
