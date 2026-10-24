import "server-only";
import { db } from "@/lib/db";
import { avatarObjectKey, MAX_IMAGE_BYTES } from "@/lib/avatars";
import { designBucket } from "@/lib/storage/design-objects";
import { reserveAvatarStorage } from "@/lib/security/avatar-budget";
import { reserveOperation } from "@/lib/security/operation-budget";
import { validateSignature, IMAGE_TYPES } from "@/lib/feedback/validation";

/** Only the two configured sign-in providers can supply external profile images. */
export function providerAvatarURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "avatars.githubusercontent.com" ||
        /^lh[3-6]\.googleusercontent\.com$/.test(url.hostname))
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Called inside the native file authority boundary; never accepts a caller-supplied URL. */
export async function desktopCreatorAvatar(userId: string, fileId: string, request: Request) {
  await reserveOperation("avatar-read", userId);
  const result = await db.query<{ id: string; image: string | null }>(
    `select u."id", u."image" from "designFile" f join "user" u on u."id"=f."createdBy" where f."id"=$1 and f."archivedAt" is null`,
    [fileId],
  );
  const creator = result.rows[0];
  const query = new URL(request.url).searchParams;
  if (!creator?.image || creator.id !== query.get("creator") || creator.image !== query.get("v"))
    return new Response(null, { status: 404 });
  const key = avatarObjectKey(creator.image, "user", creator.id);
  let response: Response;
  if (key) {
    const bucket = designBucket();
    if (!bucket) return new Response(null, { status: 503 });
    await reserveAvatarStorage("read");
    const object = await bucket.get(key);
    if (!object) return new Response(null, { status: 404 });
    response = new Response(object.body, {
      headers: { "Content-Type": object.httpMetadata?.contentType ?? "" },
    });
  } else {
    const url = providerAvatarURL(creator.image);
    if (!url) return new Response(null, { status: 404 });
    try {
      response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
        credentials: "omit",
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return boundedAvatarResponse(response, request.signal);
}

/** Bound provider/storage streams before publishing native image bytes. */
export async function boundedAvatarResponse(response: Response, signal: AbortSignal) {
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (
    !response.ok ||
    !IMAGE_TYPES.includes(type) ||
    Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    return new Response(null, { status: 404 });
  }
  const reader = response.body?.getReader();
  if (!reader) return new Response(null, { status: 404 });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    deadline.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      deadline.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) return new Response(null, { status: 404 });
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    validateSignature(type, bytes);
    return new Response(bytes, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  } finally {
    deadline.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
