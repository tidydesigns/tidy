import { parentPort } from "node:worker_threads";
import { parseDesignDocument } from "@tidy/design/document";
import { diffDocument } from "@tidy/editor/design/document-patch";
import type { ComputeRequest } from "./cloud-compute";
import { readDesignFile, summarizeDesignFile } from "./design-file";

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
const reads: Extract<ComputeRequest, { kind: "read-file" }>[] = [];
let reading = false;
async function drainReads() {
  if (reading) return;
  reading = true;
  try {
    while (reads.length) {
      // A canvas open must not wait behind a cold folder's metadata scan.
      const full = reads.findIndex((request) => !request.summary);
      await run(reads.splice(full < 0 ? 0 : full, 1)[0]);
    }
  } finally {
    reading = false;
  }
}
async function run(request: ComputeRequest) {
  try {
    if (request.kind === "read-file") {
      const file = await readDesignFile(request.path);
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
        request.kind === "read-file" && error instanceof Error
          ? error.message.slice(0, 300)
          : "This design could not be compared for sync.",
    });
  }
}
parentPort?.on("message", (request: ComputeRequest) => {
  if (request.kind === "read-file") {
    reads.push(request);
    void drainReads();
  } else void run(request);
});
