import { parseDesignDocument, type DocumentParser, type DesignDocument } from "./document";
import {
  applyDocumentPatch,
  documentPatchSchema,
  invertPatch,
  type DocumentPatch,
} from "./document-patch";
import { equalJsonValues } from "./json-value";
import { applyRevisionChanges, type RevisionChanges } from "./revision-sync";

export type RoomSnapshot = { revision: number; content: DesignDocument };
export type RoomCommit = { patch: DocumentPatch; snapshot: RoomSnapshot; sequence: number };
export type HistoryCommit = Pick<RoomCommit, "patch" | "sequence"> & {
  allowedSequences?: number[];
};
export type CommitDependency = number | Promise<HistoryCommit> | (() => Promise<HistoryCommit>);
type Pending = { operationId: string; patch: DocumentPatch };

/** Optimistic patches stay visible while their serialized requests await acknowledgment. */
export class RoomEditQueue {
  private authoritative: RoomSnapshot;
  private pending: Pending[] = [];
  private optimistic:
    | { snapshot: RoomSnapshot; operation?: Pending; pendingKey?: string }
    | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    initial: RoomSnapshot,
    private notify: (snapshot: RoomSnapshot) => void,
    private parse: DocumentParser = parseDesignDocument,
  ) {
    this.authoritative =
      this.parse === parseDesignDocument
        ? initial
        : { ...initial, content: this.parse(initial.content) };
  }
  setNotify(notify: (snapshot: RoomSnapshot) => void) {
    this.notify = notify;
  }
  get hasPendingEdits() {
    return this.pending.length > 0;
  }

  get saved() {
    return this.authoritative;
  }

  private pendingKey() {
    if (this.pending.length > 128) return;
    const maxKeyCodeUnits = 32_768;
    try {
      const operations: string[] = [];
      let codeUnits = 2;
      for (const operation of this.pending) {
        if (
          operation.patch.length > 32 ||
          operation.patch.some((change) =>
            [change.before.value, change.after.value].some(
              (value) =>
                (value !== null && typeof value === "object") ||
                (typeof value === "string" && value.length > maxKeyCodeUnits),
            ),
          )
        )
          return;
        const key = JSON.stringify({
          operationId: operation.operationId,
          patch: documentPatchSchema.parse(operation.patch),
        });
        codeUnits += key.length + 1;
        if (codeUnits > maxKeyCodeUnits) return;
        operations.push(key);
      }
      return `[${operations.join(",")}]`;
    } catch {
      return;
    }
  }

  getSnapshot(): RoomSnapshot {
    if (this.optimistic) return this.optimistic.snapshot;
    if (!this.pending.length) return this.authoritative;
    let content = this.authoritative.content;
    let applied: Pending | undefined;
    for (const operation of this.pending) {
      try {
        content = applyDocumentPatch(content, operation.patch, false, this.parse);
        if (this.pending.length === 1)
          applied = { operationId: operation.operationId, patch: structuredClone(operation.patch) };
      } catch {
        /* A rejected target must not hide other pending edits. */
      }
    }
    const snapshot = { revision: this.authoritative.revision, content };
    this.optimistic = { snapshot, operation: applied, pendingKey: this.pendingKey() };
    return snapshot;
  }
  /** Reuse a fully validated optimistic result only for the exact single edit the server accepted. */
  acknowledge(operationId: string, base: RoomSnapshot, changes: RevisionChanges): RoomSnapshot {
    const cached = this.optimistic;
    const accepted = changes.patches[0];
    if (
      this.authoritative === base &&
      this.pending.length === 1 &&
      this.pending[0].operationId === operationId &&
      cached?.operation?.operationId === operationId &&
      changes.baseRevision === base.revision &&
      changes.revision === base.revision + 1 &&
      changes.patches.length === 1 &&
      accepted.baseRevision === base.revision &&
      accepted.revision === changes.revision &&
      equalJsonValues(cached.operation.patch, accepted.patch)
    ) {
      return { revision: changes.revision, content: cached.snapshot.content };
    }
    // Server-derived edits, concurrent changes and rejected previews take the normal validation path.
    return applyRevisionChanges(base, changes, this.parse);
  }
  restore() {
    this.notify(this.getSnapshot());
  }
  receive(snapshot: RoomSnapshot) {
    if (snapshot.revision >= this.authoritative.revision) {
      this.authoritative =
        this.parse === parseDesignDocument
          ? snapshot
          : { ...snapshot, content: this.parse(snapshot.content) };
      this.optimistic = undefined;
    }
    this.restore();
  }

  commit(
    patch: DocumentPatch,
    submit: (
      operationId: string,
      patch: DocumentPatch,
      expectedSequence?: number,
      allowedSequences?: number[],
    ) => Promise<RoomCommit>,
    dependency?: CommitDependency,
  ): Promise<RoomCommit> {
    const cached = this.optimistic;
    const reuse = cached?.pendingKey !== undefined && cached.pendingKey === this.pendingKey();
    const operation = { operationId: crypto.randomUUID(), patch };
    this.pending.push(operation);
    this.optimistic = undefined;
    if (cached && reuse && this.pending.length > 1) {
      let content = cached.snapshot.content;
      try {
        content = applyDocumentPatch(content, patch, false, this.parse);
      } catch {
        /* A rejected target must not hide other pending edits. */
      }
      this.optimistic = {
        snapshot: { revision: this.authoritative.revision, content },
        pendingKey: this.pendingKey(),
      };
    }
    this.restore();
    const run = async () => {
      try {
        const previous =
          typeof dependency === "number"
            ? undefined
            : await (typeof dependency === "function" ? dependency() : dependency);
        // Undo/redo uses the acknowledged canonical patch, including server-derived changes.
        const sequence =
          previous?.sequence ?? (typeof dependency === "number" ? dependency : undefined);
        if (previous) {
          operation.patch = invertPatch(previous.patch);
          this.optimistic = undefined;
          this.restore();
        }
        const result = await submit(
          operation.operationId,
          operation.patch,
          sequence,
          previous?.allowedSequences,
        );
        this.pending = this.pending.filter((item) => item !== operation);
        this.optimistic = undefined;
        this.receive(result.snapshot);
        return result;
      } catch (error) {
        this.pending = this.pending.filter((item) => item !== operation);
        this.optimistic = undefined;
        this.restore();
        throw error;
      }
    };
    const promise = this.queue.then(run, run);
    this.queue = promise.then(
      () => {},
      () => {},
    );
    return promise;
  }
}
