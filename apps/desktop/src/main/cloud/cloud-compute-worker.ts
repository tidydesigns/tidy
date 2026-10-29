import { storedThreadSchema } from "../../shared/contracts/desktop";
import { summarizeThread } from "../../shared/models/thread-updates";
import { readLocalFile } from "../platform/local-files";
import { parentPort } from "node:worker_threads";
import { parseDesignDocument } from "@tidy/design/document";
import { diffDocument } from "@tidy/editor/design/document-patch";
import type { ComputeRequest } from "./cloud-compute";
import { DesignFileCache, summarizeDesignFile } from "../workspace/design-file";

const designFiles = new DesignFileCache();

function remap(value: unknown, aliases: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => remap(entry, aliases));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "assetId" && typeof entry === "string"
        ? (aliases[entry] ?? entry)
        : remap(entry, aliases),
    ]),
  );
}
const reads: Extract<ComputeRequest, { kind: "read-file" | "read-thread-summary" }>[] = [];
let reading = false;
async function drainReads() {
  if (reading) return;
  reading = true;
  try {
    while (reads.length) {
      // A canvas open must not wait behind a cold folder's metadata scan.
      const full = reads.findIndex(
        (request) => request.kind === "read-file" && !request.summary && !request.background,
      );
      await run(reads.splice(full < 0 ? 0 : full, 1)[0]);
    }
  } finally {
    reading = false;
  }
}
/** Encoding replies transfer ownership of UTF-8 buffers to the host.
 * Request failures return bounded error text so the host can settle its pending operation. */
async function run(request: ComputeRequest) {
  try {
    if (request.kind === "encode-thread") {
      const json = JSON.stringify(request.thread, null, 2);
      if (Buffer.byteLength(json) > 16 * 1024 * 1024)
        throw new Error("The local project file reached its size limit.");
      const value = new TextEncoder().encode(json);
      parentPort!.postMessage({ id: request.id, value }, [value.buffer]);
      return;
    }
    if (request.kind === "read-thread-summary") {
      const thread = storedThreadSchema.parse(
        JSON.parse((await readLocalFile(request.path)).toString("utf8")),
      );
      parentPort!.postMessage({ id: request.id, value: summarizeThread(thread) });
      return;
    }
    if (request.kind === "read-file") {
      const file = await designFiles.read(request.path);
      if (request.summary) {
        parentPort!.postMessage({ id: request.id, value: summarizeDesignFile(file) });
      } else parentPort!.postMessage({ id: request.id, value: file });
      return;
    }
    const value =
      request.kind === "remap"
        ? parseDesignDocument(remap(request.document, request.aliases))
        : request.kind === "diff"
          ? diffDocument(request.before, request.after)
          : diffDocument(request.before, request.after).length === 0;
    parentPort!.postMessage({ id: request.id, value });
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error:
        (request.kind === "read-file" ||
          request.kind === "read-thread-summary" ||
          request.kind === "encode-thread") &&
        error instanceof Error
          ? error.message.slice(0, 300)
          : "This design could not be compared for sync.",
    });
  }
}
parentPort?.on("message", (request: ComputeRequest | { kind: "prioritize"; path: string }) => {
  if (request.kind === "prioritize") {
    for (const queued of reads)
      if (queued.kind === "read-file" && queued.path === request.path) queued.background = false;
    return;
  }
  if (request.kind === "read-file" || request.kind === "read-thread-summary") {
    reads.push(request);
    void drainReads();
  } else void run(request);
});
