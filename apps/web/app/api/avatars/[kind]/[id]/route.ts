import { auth } from "@/lib/auth";
import { avatarObjectKey, MAX_IMAGE_BYTES, type AvatarKind } from "@/lib/avatars";
import { currentAvatar, requireAvatarAccess, updateAvatar } from "@/lib/avatar-storage";
import { FeedbackError, readUploadForm } from "@/lib/feedback/validation";
import { designBucket } from "@/lib/storage/design-objects";

export const runtime = "nodejs";
type Context = RouteContext<"/api/avatars/[kind]/[id]">;

async function target(context: Context) {
  const { kind, id } = await context.params;
  if (kind !== "user" && kind !== "organization") throw new FeedbackError("Image not found.", 404);
  return { kind: kind as AvatarKind, id };
}

function failure(error: unknown) {
  if (error instanceof FeedbackError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  console.error("Avatar request failed", error);
  return Response.json(
    { error: "Could not update the image. Please try again." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request, context: Context) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return new Response(null, { status: 401 });
    const { kind, id } = await target(context);
    await requireAvatarAccess(session.user.id, kind, id, false);
    const url = await currentAvatar(kind, id);
    const key = avatarObjectKey(url, kind, id);
    if (!key || new URL(request.url).searchParams.get("v") !== key.split("/").at(-1))
      return new Response(null, { status: 404 });
    const bucket = designBucket();
    if (!bucket) return new Response(null, { status: 503 });
    const object = await bucket.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return failure(error);
  }
}

async function mutate(request: Request, context: Context, upload: boolean) {
  const origin = new URL(process.env.BETTER_AUTH_URL || request.url).origin;
  if (request.headers.get("origin") !== origin) return new Response(null, { status: 403 });
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return new Response(null, { status: 401 });
    const { kind, id } = await target(context);
    await requireAvatarAccess(session.user.id, kind, id, true);
    let file: File | null = null;
    if (upload) {
      const form = await readUploadForm(request, MAX_IMAGE_BYTES + 64_000);
      const files = form.getAll("image");
      if (files.length !== 1 || !(files[0] instanceof File))
        throw new FeedbackError("Choose one image.");
      file = files[0];
    }
    const image = await updateAvatar(session.user.id, kind, id, file);
    return Response.json({ image }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: Context) {
  return mutate(request, context, true);
}
export async function DELETE(request: Request, context: Context) {
  return mutate(request, context, false);
}
