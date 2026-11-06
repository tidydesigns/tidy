import { randomBytes } from "node:crypto";
import type { VideoBytes } from "./video-artifacts";
import {
  VIDEO_CHUNK_BYTES,
  videoReferenceSchema,
  videoVariantSchema,
  type VideoRead,
  type VideoChunk,
  type VideoReference,
  type VideoVariant,
} from "../../shared/contracts/video-artifacts";

type ReadVideo = (input: VideoRead) => Promise<VideoBytes>;

/** Decode once at the validated RPC boundary; local playback stays binary. */
export function decodeVideoChunk(chunk: VideoChunk): VideoBytes {
  const { base64, ...metadata } = chunk;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new Error("Invalid video data.");
  return { ...metadata, bytes };
}

export function videoRange(
  header: string | null,
  size: number,
): { start: number; end: number; partial: boolean } | null {
  if (header === null) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) <= 0)
  )
    return null;
  return { start, end, partial: true };
}

/** Start with 256 KiB for seeking/startup, then amortize RPC latency with bounded 1 MiB reads. */
export async function videoResponse(request: Request, read: ReadVideo) {
  const url = new URL(request.url);
  const match = /^\/__tidy\/videos\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || url.search || !["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 404 });
  try {
    const reference = videoReferenceSchema.parse({
      projectId: match[1],
      threadId: match[2],
      artifactId: match[3],
    });
    const variant = videoVariantSchema.parse(match[4]);
    const input = { ...reference, variant };
    const metadata = await read({ ...input, offset: 0, length: 0 });
    const headers = new Headers({
      "Content-Type": metadata.mimeType,
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    if (variant === "original")
      headers.set(
        "Content-Disposition",
        `attachment; filename="${metadata.name.replace(/[^a-zA-Z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
      );
    const range = videoRange(request.headers.get("range"), metadata.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Length", String(range.end - range.start + 1));
    if (range.partial)
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    let offset = range.start;
    let cancelled = false;
    const stream =
      request.method === "HEAD"
        ? null
        : new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                if (cancelled) return;
                if (request.signal.aborted) {
                  cancelled = true;
                  controller.error(new Error("Video request cancelled."));
                  return;
                }
                try {
                  const length = Math.min(
                    offset === range.start ? 256 * 1024 : VIDEO_CHUNK_BYTES,
                    range.end - offset + 1,
                  );
                  const chunk = await read({ ...input, offset, length });
                  if (cancelled) return;
                  const bytes = chunk.bytes;
                  if (
                    chunk.size !== metadata.size ||
                    chunk.mimeType !== metadata.mimeType ||
                    bytes.length !== length
                  )
                    throw new Error("The video changed during playback.");
                  offset += bytes.length;
                  controller.enqueue(bytes);
                  if (offset > range.end) controller.close();
                } catch (error) {
                  if (!cancelled) controller.error(error);
                }
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          );
    return new Response(stream, { status: range.partial ? 206 : 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

type Capability = {
  scope?: object;
  owner: number;
  key: string;
  reference: VideoReference;
  variant: VideoVariant;
  read: ReadVideo;
};
const capabilities = new Map<string, Capability>();

/** Tokens stay in the trusted renderer and are revoked when its document closes or navigates. */
export function issueVideoURL(
  owner: number,
  reference: VideoReference,
  variant: VideoVariant,
  read: ReadVideo,
  scope?: object,
) {
  const key = JSON.stringify([reference, variant]);
  for (const [token, capability] of capabilities)
    if (capability.owner === owner && capability.key === key && capability.scope === scope) {
      capabilities.delete(token);
      capabilities.set(token, capability);
      return `tidy://app/__tidy/video-stream/${token}`;
    }
  const owned = [...capabilities].filter(([, capability]) => capability.owner === owner);
  if (owned.length >= 128) capabilities.delete(owned[0][0]);
  const token = randomBytes(32).toString("hex");
  capabilities.set(token, { owner, key, reference, variant, read, scope });
  return `tidy://app/__tidy/video-stream/${token}`;
}

export function revokeVideoURLs(owner: number) {
  for (const [token, capability] of capabilities)
    if (capability.owner === owner) capabilities.delete(token);
}

export async function nativeVideoResponse(request: Request, developmentOrigin?: string) {
  const url = new URL(request.url);
  const match = /^\/__tidy\/video-stream\/([a-f0-9]{64})$/.exec(url.pathname);
  const capability = match && !url.search ? capabilities.get(match[1]) : undefined;
  if (!capability || !match) return new Response(null, { status: 404 });
  const { reference, variant } = capability;
  const path = `/__tidy/videos/${reference.projectId}/${reference.threadId}/${reference.artifactId}/${variant}`;
  const response = await videoResponse(
    new Request(`http://localhost${path}`, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
    }),
    async (input) => {
      if (capabilities.get(match[1]) !== capability) throw new Error("Video access expired.");
      return capability.read(input);
    },
  );
  if (developmentOrigin) {
    response.headers.set("Access-Control-Allow-Origin", developmentOrigin);
    response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  return response;
}
