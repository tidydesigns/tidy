import { z } from "zod";
import { createFileVersion, listFileVersions } from "@/lib/design/file-versions";
import {
  versionUser,
  versionBody,
  versionFailure,
  versionHeaders,
} from "@/lib/design/file-version-http";
export const runtime = "nodejs";
const creation = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    expectedRevision: z.number().int().min(0).max(2147483647),
  })
  .strict();
export async function GET(request: Request, { params }: RouteContext<"/api/files/[uid]/history">) {
  try {
    const user = await versionUser(request),
      { uid } = await params;
    const cursor = new URL(request.url).searchParams.get("before") ?? undefined;
    if (cursor !== undefined)
      z.string()
        .refine(
          (value) => /^\d{1,19}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"),
        )
        .parse(cursor);
    return Response.json(await listFileVersions(user, uid, cursor), { headers: versionHeaders });
  } catch (error) {
    return versionFailure(error);
  }
}
export async function POST(request: Request, { params }: RouteContext<"/api/files/[uid]/history">) {
  try {
    const user = await versionUser(request, true),
      { uid } = await params;
    const input = creation.parse(await versionBody(request));
    return Response.json(
      { id: await createFileVersion(user, uid, input.name, input.expectedRevision, input.id) },
      { headers: versionHeaders },
    );
  } catch (error) {
    return versionFailure(error);
  }
}
