import { invertPatch, type DocumentPatch } from "./document-patch";
import type { HistoryCommit, RoomCommit } from "./room-edit-queue";

export type HistorySelection = { selection: string | null; selectedIds: string[]; pageId: string };
type Entry = {
  patch: DocumentPatch;
  committed: Promise<HistoryCommit>;
  failed: boolean;
  bytes: number;
  selection: HistorySelection;
  allowed: Map<string, number>;
};
const propertyKey = (change: DocumentPatch[number], length = change.path.length) =>
  JSON.stringify([change.collection, change.id, change.path.slice(0, length)]);

/** History moves with the interaction; acknowledgments only refine canonical patches. */
export class EditHistory {
  private undo: Entry[] = [];
  private redo: Entry[] = [];
  private traveling = new Set<Entry>();
  constructor(
    private limit = 50,
    private byteBudget = 8_000_000,
  ) {}
  private trim(entries: Entry[]) {
    let bytes = 0;
    let start = entries.length;
    for (
      let index = entries.length - 1;
      index >= Math.max(0, entries.length - this.limit);
      index--
    ) {
      bytes += entries[index].bytes;
      if (bytes > this.byteBudget) break;
      start = index;
    }
    return entries.slice(start);
  }
  private observe(entry: Entry) {
    void entry.committed.then(
      (result) => {
        entry.patch = invertPatch(result.patch);
        entry.bytes = JSON.stringify(entry.patch).length * 2;
        if (!entry.patch.length) this.remove(entry);
        this.undo = this.trim(this.undo);
        this.redo = this.trim(this.redo);
      },
      () => {
        entry.failed = true;
        this.remove(entry);
      },
    );
  }
  private remove(entry: Entry) {
    this.undo = this.undo.filter((item) => item !== entry);
    this.redo = this.redo.filter((item) => item !== entry);
  }
  record(patch: DocumentPatch, committed: Promise<RoomCommit>, selection: HistorySelection) {
    const acknowledgment = committed.then(({ patch, sequence }) => ({ patch, sequence }));
    const entry = {
      patch: invertPatch(patch),
      committed: acknowledgment,
      failed: false,
      bytes: JSON.stringify(patch).length * 2,
      selection,
      allowed: new Map<string, number>(),
    };
    this.undo = this.trim([...this.undo, entry]);
    this.redo = [];
    this.observe(entry);
  }
  travel(
    direction: "undo" | "redo",
    selection: HistorySelection,
    commit: (patch: DocumentPatch, dependency: () => Promise<HistoryCommit>) => Promise<RoomCommit>,
  ) {
    const source = direction === "undo" ? this.undo : this.redo;
    const entry = source.at(-1);
    if (!entry) return null;
    this.traveling.add(entry);
    const committed = commit(entry.patch, async () => ({
      ...(await entry.committed),
      allowedSequences: [...new Set(entry.allowed.values())],
    }));
    const acknowledgment = committed.then(({ patch, sequence }) => ({ patch, sequence }));
    const next = {
      patch: invertPatch(entry.patch),
      committed: acknowledgment,
      failed: false,
      bytes: entry.bytes,
      selection,
      allowed: new Map<string, number>(),
    };
    if (direction === "undo") {
      this.undo = source.slice(0, -1);
      this.redo = this.trim([...this.redo, next]);
    } else {
      this.redo = source.slice(0, -1);
      this.undo = this.trim([...this.undo, next]);
    }
    // Restore a rejected history action only if later interactions have not replaced it.
    void committed.then(
      (result) => {
        const exact = new Set(result.patch.map((change) => propertyKey(change)));
        const prefixes = new Set(
          result.patch.flatMap((change) =>
            Array.from({ length: change.path.length + 1 }, (_, index) =>
              propertyKey(change, index),
            ),
          ),
        );
        for (const candidate of new Set([...this.undo, ...this.redo, ...this.traveling]))
          for (const change of candidate.patch) {
            if (
              prefixes.has(propertyKey(change)) ||
              change.path.some((_, index) => exact.has(propertyKey(change, index)))
            )
              candidate.allowed.set(propertyKey(change), result.sequence);
          }
        this.traveling.delete(entry);
      },
      () => {
        this.traveling.delete(entry);
        const destination = direction === "undo" ? this.redo : this.undo;
        if (!destination.includes(next)) return;
        this.remove(next);
        if (!entry.failed) {
          if (direction === "undo") this.undo = this.trim([...this.undo, entry]);
          else this.redo = this.trim([...this.redo, entry]);
        }
      },
    );
    this.observe(next);
    return { selection: entry.selection, committed };
  }
}
