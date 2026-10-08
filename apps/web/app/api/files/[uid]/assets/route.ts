import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { can } from "@/lib/organizations/roles";
import { auth } from "@/lib/auth";
import { getDesignFile } from "@/lib/design/service";
import { putAsset } from "@/lib/design/document-service";
import { listFileAssets } from "@/lib/design/asset-browser";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/files/[uid]/assets">) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  try {
    const result = await listFileAssets(
      session.user.id,
      uid,
      new URL(request.url).searchParams.get("cursor"),
    );
    return result
      ? Response.json(result, { headers: { "Cache-Control": "private, no-store" } })
      : new Response(null, { status: 404 });
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : "Could not load assets." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, { params }: RouteContext<"/api/files/[uid]/assets">) {
  if (
    request.headers.get("origin") !==
    new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin
  )
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  const file = await getDesignFile(session.user.id, uid);
  if (!file) return new Response(null, { status: 404 });
  if (!can(file.role, "edit"))
    return Response.json({ error: "Editor access is required to upload images." }, { status: 403 });
  const length = Number(request.headers.get("content-length"));
  if (length > 2_800_000)
    return Response.json({ error: "Image must be under 2 MB." }, { status: 413 });
  try {
    const form = await (await boundedRequest(request, 2_800_000)).formData();
    const upload = form.get("image");
    if (!(upload instanceof File) || upload.size > 2_000_000)
      return Response.json({ error: "Choose an image under 2 MB." }, { status: 400 });
    const bytes = Buffer.from(await upload.arrayBuffer());
    const result = await putAsset(
      session.user.id,
      file.organizationId,
      upload.type,
      bytes.toString("base64"),
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof RequestBodyError) return requestBodyError(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not upload image." },
      { status: 400 },
    );
  }
}
