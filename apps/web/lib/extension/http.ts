import { DEVELOPMENT_EXTENSION_ID } from "@tidy/design/extension";
import { MAX_CAPTURE_BYTES } from "@tidy/design/web-capture";
import { themeFromCookies } from "@/lib/theme";
import { PublicActionError } from "@/lib/security/public-error";
import { ZodError } from "zod";
import { boundedRequest, RequestBodyError } from "@/lib/http/request-body";

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
    readonly status: 400 | 408 | 413 | 415 = 400,
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

export async function readCaptureBody(request: Request, timeoutMs = 15_000) {
  if (
    !request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .match(/^application\/json$/i)
  )
    throw new CaptureBodyError("Use application/json.");
  if (!request.body) throw new CaptureBodyError("Capture body is missing.");
  let bounded: Request;
  try {
    bounded = await boundedRequest(request, MAX_CAPTURE_BYTES, timeoutMs);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      if (error.status === 413) throw new CaptureBodyError("Capture exceeds 16 MB.", 413);
      if (error.status === 408)
        throw new CaptureBodyError("Capture upload timed out or was canceled. Try again.", 408);
      if (error.status === 415) throw new CaptureBodyError("Unsupported capture encoding.", 415);
      throw new CaptureBodyError("Invalid capture body.");
    }
    throw error;
  }
  try {
    return (await bounded.json()) as unknown;
  } catch {
    throw new CaptureBodyError("Capture body must contain valid JSON.");
  }
}
