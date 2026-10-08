/** Bound the bytes actually received before handing a body to JSON/multipart parsers. */
export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function boundedRequest(
  request: Request,
  limit = 65_536,
  timeoutMs = 10_000,
): Promise<Request> {
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity")
    throw new RequestBodyError("Unsupported content encoding.", 415);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new RequestBodyError("Invalid content length.", 400);
  }
  if (length !== null && Number(length) > limit) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyError("Request body is too large.", 413);
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new RequestBodyError("Request body is too large.", 413);
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Next can supply a proxy around the native request. Passing that proxy to
    // the constructor fails native private-field checks on newer Node versions.
    // Reconstruct from public fields while retaining cookies and cancellation.
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
    });
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (signal.aborted) throw new RequestBodyError("Request body timed out or was canceled.", 408);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function requestBodyError(error: RequestBodyError) {
  return Response.json(
    { error: error.message },
    { status: error.status, headers: { "Cache-Control": "no-store" } },
  );
}

/** For small control endpoints, limit input before invoking third-party parsers. */
export function withRequestBodyLimit<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
  limit = 65_536,
) {
  return async (request: Request, ...args: Args) => {
    try {
      return await handler(await boundedRequest(request, limit), ...args);
    } catch (error) {
      if (error instanceof RequestBodyError) return requestBodyError(error);
      throw error;
    }
  };
}
