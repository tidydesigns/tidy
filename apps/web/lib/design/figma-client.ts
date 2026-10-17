import type { FigmaImport, FigmaPage } from "@tidy/design/figma";
type Input = {
  bytes?: Uint8Array;
  html?: string;
  name?: string;
  pages?: string[];
  inspect?: boolean;
};
export function readFigma(input: Input, signal?: AbortSignal): Promise<FigmaImport> {
  return runFigmaWorker<FigmaImport>(input, signal);
}
export function inspectFigma(input: Input, signal?: AbortSignal): Promise<FigmaPage[]> {
  return runFigmaWorker<FigmaPage[]>({ ...input, inspect: true }, signal);
}
function runFigmaWorker<T>(input: Input, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./figma.worker.ts", import.meta.url));
    const finish = (cause?: Error, result?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (cause) reject(cause);
      else resolve(result!);
    };
    const abort = () => finish(new Error("Figma import cancelled."));
    const timer = setTimeout(
      () =>
        finish(new Error("This Figma design took too long to decode. Export a smaller selection.")),
      20_000,
    );
    worker.onmessage = (event: MessageEvent<{ result?: T; pages?: T; error?: string }>) =>
      finish(
        event.data.error ? new Error(event.data.error) : undefined,
        event.data.result ?? event.data.pages,
      );
    worker.onerror = () =>
      finish(new Error("Could not read this Figma design. Try exporting a new .fig copy."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage(input, input.bytes ? [input.bytes.buffer as ArrayBuffer] : []);
  });
}
export function remapFigmaAssets(result: FigmaImport, ids: Map<string, string>): FigmaImport {
  return {
    ...result,
    document: {
      ...result.document,
      nodes: result.document.nodes.map((node) => ({
        ...node,
        assetId: node.assetId ? ids.get(node.assetId) : undefined,
        style: {
          ...node.style,
          paints: node.style.paints?.map((paint) =>
            paint.type === "image"
              ? { ...paint, assetId: paint.assetId ? ids.get(paint.assetId) : undefined }
              : paint,
          ),
        },
      })),
    },
  };
}
