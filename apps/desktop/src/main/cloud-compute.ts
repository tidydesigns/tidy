import { Worker } from "node:worker_threads";
import type { DesignDocument } from "@tidy/design/document";
import type { DocumentPatch } from "@tidy/editor/design/document-patch";
import type { ParsedDesignFile, DesignFileSummary } from "./design-file";

export type ComputeRequest = { id: number } & (
  | { kind: "equal" | "diff"; before: DesignDocument; after: DesignDocument }
  | { kind: "remap"; document: DesignDocument; aliases: Record<string, string> }
  | { kind: "read-file"; path: string; summary: boolean }
);

/** Diffing and asset translation must not occupy Electron's main event loop,
 * which also handles immediate local saves and agent events. */
export class CloudCompute {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private run<T>(
    input:
      | Omit<Extract<ComputeRequest, { kind: "equal" | "diff" }>, "id">
      | Omit<Extract<ComputeRequest, { kind: "remap" }>, "id">
      | Omit<Extract<ComputeRequest, { kind: "read-file" }>, "id">,
  ): Promise<T> {
    if (!this.worker) {
      const worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./cloud-compute-worker.ts"
            : "./cloud-compute-worker.js",
          import.meta.url,
        ),
      );
      this.worker = worker;
      worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
        const task = this.pending.get(message.id);
        if (!task) return;
        this.pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error));
        else task.resolve(message.value);
        if (!this.pending.size) worker.unref();
      });
      const failed = () => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const task of this.pending.values())
          task.reject(new Error("Cloud comparison stopped. Sync will retry."));
        this.pending.clear();
      };
      worker.on("error", failed);
      worker.on("exit", failed);
    }
    this.worker.ref();
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker!.postMessage({ ...input, id });
    });
  }
  equal(before: DesignDocument, after: DesignDocument) {
    if (before === after) return Promise.resolve(true);
    return this.run<boolean>({ kind: "equal", before, after });
  }
  diff(before: DesignDocument, after: DesignDocument) {
    return this.run<DocumentPatch>({ kind: "diff", before, after });
  }
  remap(document: DesignDocument, aliases: Record<string, string>) {
    if (!Object.keys(aliases).length) return Promise.resolve(document);
    return this.run<DesignDocument>({ kind: "remap", document, aliases });
  }
  readFile(path: string) {
    return this.run<ParsedDesignFile>({ kind: "read-file", path, summary: false });
  }
  readSummary(path: string) {
    return this.run<DesignFileSummary>({ kind: "read-file", path, summary: true });
  }
  async close() {
    const worker = this.worker;
    if (worker) await worker.terminate();
  }
}
