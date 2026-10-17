import { DEVELOPMENT_EXTENSION_ID } from "@tidy/design/extension";
import { MAX_CAPTURE_BYTES } from "@tidy/design/web-capture";
import { themeFromCookies } from "@/lib/theme";
import { PublicActionError } from "@/lib/security/public-error";
import { ZodError } from "zod";

export function extensionOrigin(request: Request) {
  const ids = (
    process.env.BELLA_EXTENSION_IDS ??
    (process.env.NODE_ENV === "production" ? "" : DEVELOPMENT_EXTENSION_ID)
  )
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[a-p]{32}$/.test(id));
  const origin = request.headers.get("origin");
  return origin && ids.some((id) => origin === `chrome-extension://${id}`) ? origin : null;
}

export class CaptureBodyError extends PublicActionError {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

export function extensionError(error: unknown) {
  if (error instanceof CaptureBodyError) return { message: error.message, status: error.status };
  if (error instanceof ZodError)
    return { message: "Capture is invalid or exceeds Tidy's design limits.", status: 400 };
  if (error instanceof PublicActionError)
    return {
      message: error.message,
      status: /access denied|not found/i.test(error.message)
        ? 403
        : /changed|conflict/i.test(error.message)
          ? 409
          : 400,
    };
  return { message: "Could not import webpage. Try again later.", status: 500 };
}

export function extensionHeaders(request: Request) {
  const headers = new Headers({ "Cache-Control": "private, no-store", Vary: "Origin" });
  headers.set("X-Tidy-Theme", themeFromCookies(request.headers.get("cookie")));
  const origin = extensionOrigin(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Tidy-Extension");
    headers.set("Access-Control-Expose-Headers", "X-Tidy-Theme, Retry-After");
  }
  return headers;
}

export function extensionRequestAllowed(request: Request) {
  // GETs from an extension can omit Origin; mutation requests must provide it.
  return (
    request.headers.get("x-tidy-extension") === "1" &&
    ((request.method === "GET" && !request.headers.get("origin")) ||
      Boolean(extensionOrigin(request)))
  );
}

export function extensionPreflight(request: Request) {
  return new Response(null, {
    status: extensionOrigin(request) ? 204 : 403,
    headers: extensionHeaders(request),
  });
}

export async function readCaptureBody(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .match(/^application\/json$/i)
  )
    throw new CaptureBodyError("Use application/json.");
  if (Number(request.headers.get("content-length")) > MAX_CAPTURE_BYTES)
    throw new CaptureBodyError("Capture exceeds 16 MB.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CaptureBodyError("Capture body is missing.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CAPTURE_BYTES) {
        await reader.cancel();
        throw new CaptureBodyError("Capture exceeds 16 MB.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CaptureBodyError("Capture body must contain valid JSON.");
  }
}
