import { DEVELOPMENT_EXTENSION_ID } from "@bella/design/extension";
import { MAX_CAPTURE_BYTES } from "@bella/design/web-capture";

export function extensionOrigin(request: Request) {
  const ids = (process.env.BELLA_EXTENSION_IDS ?? DEVELOPMENT_EXTENSION_ID)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[a-p]{32}$/.test(id));
  const origin = request.headers.get("origin");
  return origin && ids.some((id) => origin === `chrome-extension://${id}`) ? origin : null;
}

export function extensionHeaders(request: Request) {
  const headers = new Headers({ "Cache-Control": "private, no-store", Vary: "Origin" });
  const origin = extensionOrigin(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Bella-Extension");
  }
  return headers;
}

export function extensionRequestAllowed(request: Request) {
  // GETs from an extension can omit Origin; mutation requests must provide it.
  return (
    request.headers.get("x-bella-extension") === "1" &&
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
    throw new Error("Use application/json.");
  if (Number(request.headers.get("content-length")) > MAX_CAPTURE_BYTES)
    throw new Error("Capture exceeds 16 MB.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Capture body is missing.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CAPTURE_BYTES) {
        await reader.cancel();
        throw new Error("Capture exceeds 16 MB.");
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
