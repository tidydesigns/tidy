import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectStore } from "./project-store";

/** Project images are requested separately from the design IPC payload. Never
 * interpret URL text as a filesystem path or serve uploaded content as HTML. */
export async function projectAssetResponse(
  store: ProjectStore,
  request: Request,
  developmentOrigin?: string,
  authorize?: (projectId: string) => Promise<void>,
  load?: (projectId: string, assetId: string) => Promise<string | undefined>,
) {
  const url = new URL(request.url);
  const match = /^\/__tidy\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (
    !match ||
    (url.search && !/^\?retry=\d{1,9}$/.test(url.search)) ||
    !["GET", "HEAD"].includes(request.method)
  )
    return new Response(null, { status: 404 });
  try {
    const projectId = z.uuid().parse(match[1]);
    const assetId = z.uuid().parse(match[2]);
    const check = async () => {
      if (!authorize && store.project(projectId).cloud)
        throw new Error("Cloud images require account authorization.");
      await authorize?.(projectId);
    };
    await check();
    let dataUrl = await store.readSyncAsset(projectId, assetId);
    if (!dataUrl && load) dataUrl = await load(projectId, assetId);
    await check();
    if (dataUrl && dataUrl.length > 3_000_000) return new Response(null, { status: 404 });
    const image = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl ?? "",
    );
    if (!image) return new Response(null, { status: 404 });
    const bytes = Buffer.from(image[2], "base64");
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    const headers = {
      "Content-Type": image[1],
      "Cache-Control": "private, max-age=0, must-revalidate",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": developmentOrigin ? "cross-origin" : "same-origin",
      ...(developmentOrigin ? { "Access-Control-Allow-Origin": developmentOrigin } : {}),
      ETag: etag,
    };
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}
