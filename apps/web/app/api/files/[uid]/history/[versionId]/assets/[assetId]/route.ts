import { z } from "zod";
import { fileVersionAsset } from "@/lib/design/file-versions";
import { versionUser, versionFailure } from "@/lib/design/file-version-http";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/history/[versionId]/assets/[assetId]">,
) {
  try {
    const user = await versionUser(request),
      { uid, versionId, assetId } = await params;
    z.string().uuid().parse(versionId);
    return await fileVersionAsset(user, uid, versionId, assetId, request);
  } catch (error) {
    return versionFailure(error);
  }
}
