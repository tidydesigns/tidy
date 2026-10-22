import { parentPort } from "node:worker_threads";
import { parseDesignDocument } from "@tidy/design/document";
import { diffDocument } from "@tidy/editor/design/document-patch";
import type { ComputeRequest } from "./cloud-compute";

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
parentPort?.on("message", (request: ComputeRequest) => {
  try {
    const value =
      request.kind === "remap"
        ? parseDesignDocument(remap(request.document, request.aliases))
        : request.kind === "diff"
          ? diffDocument(request.before, request.after)
          : diffDocument(request.before, request.after).length === 0;
    parentPort!.postMessage({ id: request.id, value });
  } catch {
    parentPort!.postMessage({
      id: request.id,
      error: "This design could not be compared for sync.",
    });
  }
});
