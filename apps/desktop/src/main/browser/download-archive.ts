import * as http from "node:http";
import * as https from "node:https";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function downloadBrowserArchive({
  url,
  path,
  signal,
  progress,
}: {
  url: URL;
  path: string;
  signal: AbortSignal;
  progress(downloaded: number, total: number): void;
}) {
  const temporary = `${path}.${randomUUID()}.partial`;
  const download = async (url: URL, redirects: number): Promise<void> => {
    if (!["https:", "http:"].includes(url.protocol) || redirects > 5)
      throw new Error("The browser download redirected to an unsupported address.");
    const secure = url.protocol === "https:";
    const agent = secure
      ? new https.Agent({ proxyEnv: process.env })
      : new http.Agent({ proxyEnv: process.env });
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const request = (secure ? https.get : http.get)(url, { agent, signal }, resolve);
        request.setTimeout(30000, () =>
          request.destroy(
            new Error("The browser download stalled. Retry when the connection is available."),
          ),
        );
        request.once("error", reject);
      });
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (secure && next.protocol !== "https:")
          throw new Error("The browser download requires HTTPS.");
        await download(next, redirects + 1);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(
          `The browser download failed (${response.statusCode ?? "no response"}). Retry shortly.`,
        );
      }
      const total = Number(response.headers["content-length"] ?? 0);
      let downloaded = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.length;
          if (downloaded > 512 * 1024 * 1024 || total > 512 * 1024 * 1024) {
            callback(new Error("The browser archive exceeds the download limit."));
            return;
          }
          progress(downloaded, total);
          callback(null, chunk);
        },
      });
      await pipeline(response, meter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), {
        signal,
      });
      if (total > 0 && downloaded !== total)
        throw new Error("The browser download was interrupted. Retry shortly.");
    } finally {
      agent.destroy();
    }
  };
  try {
    await download(url, 0);
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
