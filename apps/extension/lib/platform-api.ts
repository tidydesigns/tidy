import { MAX_CAPTURE_BYTES } from "@tidy/design/web-capture";

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

/** Bound decoded response bytes, including chunked responses with no Content-Length. */
export async function readPlatformResponse(
  response: Response,
  limit = 4 * 1024 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new PlatformError("Tidy returned an empty response.");
  let bytes = 0;
  const decoder = new TextDecoder();
  let text = "";
  try {
    if (Number(response.headers.get("content-length")) > limit)
      throw new PlatformError("Tidy's response is too large.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new PlatformError("Tidy's response is too large.");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof PlatformError) throw error;
    throw new PlatformError("Tidy is unavailable. Try again.", response.status);
  } finally {
    reader.releaseLock();
  }
}

export function serializeCaptureRequest(value: unknown): string {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_CAPTURE_BYTES)
    throw new PlatformError("This capture exceeds 16 MB. Select fewer elements.");
  return body;
}
export function platformRetryAfter(value: string | null, now = Date.now()) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(0, seconds)) : 0;
}
