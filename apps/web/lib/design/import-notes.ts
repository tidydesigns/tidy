import type { DesignDocument } from "./document";

export type ImportNote = DesignDocument["warnings"][number];
export type ImportNoteStatus = NonNullable<ImportNote["status"]>;

export function importNoteKey(note: ImportNote) {
  return JSON.stringify([
    note.importKey ?? "",
    note.nodeId ?? "",
    note.message.trim().replace(/\s+/g, " "),
  ]);
}

export function importNotes(document: DesignDocument): ImportNote[] {
  const notes = new Map<string, ImportNote>();
  const sourceKey = document.source
    ? `${document.source.project}:${document.source.route}`
    : undefined;
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  for (const warning of document.warnings) {
    // Explicit null preserves unknown provenance when the document later acquires a source.
    const note = {
      ...warning,
      importKey:
        warning.importKey !== undefined
          ? warning.importKey
          : ((warning.nodeId ? nodes.get(warning.nodeId)?.importKey : sourceKey) ?? null),
    };
    const key = importNoteKey(note);
    const previous = notes.get(key);
    // Duplicated legacy notes should not reset an acknowledgement.
    const rank = { unread: 0, read: 1, dismissed: 2 };
    if (!previous || rank[note.status ?? "unread"] > rank[previous.status ?? "unread"])
      notes.set(key, note);
  }
  return [...notes.values()];
}

export function setImportNoteStatus(
  document: DesignDocument,
  key: string,
  status: ImportNoteStatus,
): DesignDocument {
  return {
    ...document,
    warnings: importNotes(document).map((note) =>
      importNoteKey(note) === key ? { ...note, status } : note,
    ),
  };
}

export function reconcileImportNotes(
  current: DesignDocument | null,
  incoming: DesignDocument,
  key: string | undefined,
  ids = new Map<string, string>(),
  duplicate = false,
): ImportNote[] {
  const previous = current ? importNotes(current) : [];
  const next = importNotes(incoming).map((note) => ({
    ...note,
    importKey: key ?? null,
    nodeId: note.nodeId ? (ids.get(note.nodeId) ?? note.nodeId) : undefined,
    status: "unread" as ImportNoteStatus,
  }));
  const priorByKey = new Map(previous.map((note) => [importNoteKey(note), note]));
  const refreshed = next.map((note) => ({
    ...note,
    status: duplicate
      ? ("unread" as const)
      : (priorByKey.get(importNoteKey(note))?.status ?? "unread"),
  }));
  // Unattributed legacy notes cannot safely be retired on behalf of a source.
  const retained = duplicate ? previous : previous.filter((note) => note.importKey !== key);
  return [
    ...new Map([...retained, ...refreshed].map((note) => [importNoteKey(note), note])).values(),
  ];
}
