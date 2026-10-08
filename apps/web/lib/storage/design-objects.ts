import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createHash } from "node:crypto";
import { requestSignal, waitForSignal } from "@/lib/request-lifecycle";
import { boundedRequest } from "@/lib/http/request-body";
import { db } from "@/lib/db";
import { IMAGE_READ_LIMITS } from "@/lib/security/resource-limits";

export type StoredImage = {
  mimeType: string;
  objectKey: string | null;
  sha256: string | null;
  byteSize: number | null;
};
type ObjectEnvironment = CloudflareEnv & { DESIGN_OBJECTS?: R2Bucket; IMAGES?: ImagesBinding };

export function designObjectContext() {
  try {
    return getCloudflareContext() as ReturnType<typeof getCloudflareContext> & {
      env: ObjectEnvironment;
    };
  } catch {
    return null;
  }
}

export function designBucket() {
  const context = designObjectContext();
  if (context && !context.env.DESIGN_OBJECTS)
    throw new Error("DESIGN_OBJECTS R2 binding is missing.");
  return context?.env.DESIGN_OBJECTS ?? null;
}

/** Immutable, organization-scoped originals may be shared by live and review rows. */
export function designObjectKey(organizationId: string, digest: string, mimeType: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid asset digest.");
  const suffix = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  }[mimeType];
  if (!suffix) throw new Error("Unsupported image type.");
  return `originals/${encodeURIComponent(organizationId)}/${digest}.${suffix}`;
}

export async function storeDesignObject(
  organizationId: string,
  mimeType: string,
  bytes: Uint8Array,
  usageKind: "asset" | "thumbnail" = "asset",
  signal?: AbortSignal,
) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bucket = designBucket();
  if (!bucket) return { objectKey: null, sha256, byteSize: bytes.byteLength };
  const parent = requestSignal();
  const activeSignal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(parent ? [parent] : []),
    ...(signal ? [signal] : []),
  ]);
  activeSignal.throwIfAborted();
  const objectKey = designObjectKey(organizationId, sha256, mimeType);
  // Claim before touching R2. GC locks this row and ignores recent claims, so it
  // cannot remove an original between upload and publication of its asset row.
  await db.query(
    `insert into "designObject" ("objectKey","organizationId","mimeType","sha256","byteSize","usageKind") values ($1,$2,$3,$4,$5,$6)
    on conflict ("objectKey") do update set "lastClaimedAt"=now(), "usageKind"=case when "designObject"."usageKind"='asset' or excluded."usageKind"='asset' then 'asset' else 'thumbnail' end`,
    [objectKey, organizationId, mimeType, sha256, bytes.byteLength, usageKind],
  );
  // Concurrent uploads of identical bytes never overwrite an existing original.
  activeSignal.throwIfAborted();
  const stored = await waitForSignal(
    bucket.put(objectKey, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: mimeType },
      customMetadata: { sha256 },
    }),
    activeSignal,
  );
  if (!stored) {
    const existing = await waitForSignal(bucket.head(objectKey), activeSignal);
    if (!existing || existing.size !== bytes.byteLength)
      throw new Error("Stored asset verification failed.");
    const digest =
      existing.customMetadata?.sha256 ??
      createHash("sha256")
        .update(
          await designObjectBytes(
            { mimeType, objectKey, sha256, byteSize: bytes.byteLength },
            async () => null,
            bytes.byteLength,
            activeSignal,
          ),
        )
        .digest("hex");
    if (digest !== sha256) throw new Error("Stored asset verification failed.");
  }
  return { objectKey, sha256, byteSize: bytes.byteLength };
}

/** Call only after checking the row's current user/organization/repository access. */
export async function designObjectBytes(
  image: StoredImage,
  fallback: () => Promise<Buffer | null>,
  maxBytes?: number,
  signal?: AbortSignal,
) {
  const parent = requestSignal();
  const activeSignal =
    maxBytes === undefined
      ? undefined
      : AbortSignal.any([
          AbortSignal.timeout(10_000),
          ...(signal ? [signal] : []),
          ...(parent ? [parent] : []),
        ]);
  activeSignal?.throwIfAborted();
  if (image.objectKey) {
    const read = designBucket()?.get(image.objectKey);
    const object = activeSignal
      ? await waitForSignal(Promise.resolve(read), activeSignal)
      : await read;
    if (object && "body" in object) {
      if (maxBytes === undefined) return Buffer.from(await object.arrayBuffer());
      if (object.size > maxBytes) {
        void object.body.cancel().catch(() => {});
        throw new Error("Asset bytes exceed the read allowance.");
      }
      // Enforce actual streamed bytes and the shared ten-second body deadline.
      const request = new Request("https://design-object.internal/bytes", {
        method: "POST",
        signal: activeSignal,
        body: object.body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      return Buffer.from(await (await boundedRequest(request, maxBytes)).arrayBuffer());
    }
  }
  const legacy = fallback();
  const bytes = activeSignal ? await waitForSignal(legacy, activeSignal) : await legacy;
  activeSignal?.throwIfAborted();
  if (!bytes) throw new Error("Asset bytes are unavailable.");
  if (maxBytes !== undefined && bytes.length > maxBytes)
    throw new Error("Asset bytes exceed the read allowance.");
  return bytes;
}

const widths = new Set([128, 256, 512, 1024, 2048]);
export function displayImageWidth(request?: Request) {
  const width = Number(request ? new URL(request.url).searchParams.get("width") : 0);
  return widths.has(width) ? width : 0;
}

async function responseImageBytes(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error("Image bytes are unavailable.");
  const input = new Request("https://design-object.internal/image", {
    method: "POST",
    body: response.body,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const bytes = new Uint8Array(
    await (await boundedRequest(input, IMAGE_READ_LIMITS.bytes)).arrayBuffer(),
  );
  if (!bytes.length) throw new Error("Image bytes are unavailable.");
  return bytes;
}

/** Caller retains current authority until every returned image byte is bounded
 * and loaded. The internal cache stores bytes only and never authorizes a read. */
export async function designImageResponse(
  image: StoredImage,
  fallback: () => Promise<Buffer | null>,
  request?: Request,
) {
  const parent = requestSignal();
  const signal = AbortSignal.any([
    AbortSignal.timeout(IMAGE_READ_LIMITS.deadlineMs),
    ...(parent ? [parent] : []),
    ...(request ? [request.signal] : []),
  ]);
  signal.throwIfAborted();
  if (
    image.byteSize !== null &&
    image.byteSize !== undefined &&
    (!Number.isSafeInteger(image.byteSize) ||
      image.byteSize < 1 ||
      image.byteSize > IMAGE_READ_LIMITS.bytes)
  )
    throw new Error("Image bytes exceed the read allowance.");
  const context = designObjectContext();
  const bucket = image.objectKey ? designBucket() : null;
  const width =
    image.mimeType !== "image/svg+xml" && context?.env.IMAGES ? displayImageWidth(request) : 0;
  const etag = image.sha256 ? `"${image.sha256}${width ? `-w${width}-v1` : ""}"` : undefined;
  const headers = new Headers({
    "Content-Type": width ? "image/webp" : image.mimeType,
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (etag) headers.set("ETag", etag);
  if (
    etag &&
    request?.headers
      .get("if-none-match")
      ?.split(",")
      .map((value) => value.trim())
      .includes(etag)
  )
    return new Response(null, { status: 304, headers });
  let cache: Cache | undefined;
  let cacheKey: Request | undefined;
  if (context && image.objectKey && request) {
    cache = (caches as CacheStorage & { default: Cache }).default;
    cacheKey = new Request(
      new URL(
        `/__design-object-cache/${encodeURIComponent(image.objectKey)}/${width || "original"}/v1`,
        request.url,
      ),
    );
    const hit = await waitForSignal(cache.match(cacheKey), signal);
    if (hit) return new Response(await responseImageBytes(hit, signal), { headers });
  }
  let response: Response;
  const object =
    bucket && image.objectKey ? await waitForSignal(bucket.get(image.objectKey), signal) : null;
  if (object && "body" in object) {
    if (object.size > IMAGE_READ_LIMITS.bytes) {
      void object.body.cancel().catch(() => {});
      throw new Error("Image bytes exceed the read allowance.");
    }
    const bytes = await responseImageBytes(new Response(object.body), signal);
    if (width) {
      const optimized = await waitForSignal(
        context!.env
          .IMAGES!.input(new Response(bytes).body!)
          .transform({ width, fit: "scale-down" })
          .output({ format: "image/webp", quality: 85 }),
        signal,
      );
      response = new Response(await responseImageBytes(optimized.response(), signal), { headers });
    } else response = new Response(bytes, { headers });
  } else {
    const bytes = await waitForSignal(fallback(), signal);
    if (!bytes)
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > IMAGE_READ_LIMITS.bytes)
      throw new Error("Image bytes exceed the read allowance.");
    headers.set("Content-Type", image.mimeType);
    // A legacy original is never cached under a transformed variant's identity.
    if (width) {
      headers.delete("ETag");
      cache = undefined;
    }
    response = new Response(new Uint8Array(bytes), { headers });
  }
  if (cache && cacheKey) {
    const cached = response.clone();
    cached.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    (context!.ctx as ExecutionContext).waitUntil(
      waitForSignal(cache.put(cacheKey, cached), AbortSignal.timeout(10_000)).catch(() => {}),
    );
  }
  return response;
}
