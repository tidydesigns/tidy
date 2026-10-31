import type {
  RepositoryDirectory,
  RepositoryEntry,
  RepositoryFile,
} from "../../../../shared/contracts/repository-files";

export type TreeRow = RepositoryEntry & { depth: number; position: number; siblings: number };
export function visibleTreeRows(
  directories: ReadonlyMap<string, RepositoryDirectory>,
  expanded: ReadonlySet<string>,
) {
  const result: TreeRow[] = [];
  function visit(path: string, depth: number) {
    const entries = directories.get(path)?.entries ?? [];
    entries.forEach((entry, index) => {
      result.push({ ...entry, depth, position: index + 1, siblings: entries.length });
      if (entry.kind === "directory" && expanded.has(entry.path)) visit(entry.path, depth + 1);
    });
  }
  visit("", 1);
  return result;
}

export type CodeLine = {
  text: string;
  number: number;
  emphasis?: [number, number];
  tokens?: { text: string; classes: string }[];
};
export type CodeRow =
  | { kind: "lines"; before: CodeLine | null; after: CodeLine | null; changed: boolean }
  | { kind: "hunk"; before: number; after: number; hidden?: number }
  | { kind: "note"; text: string; side: "before" | "after" | "both" };
export type FileRows = {
  rows: CodeRow[];
  limited: boolean;
  longLines: boolean;
  split: boolean;
  added: number;
  removed: number;
  beforeWidth: number;
  afterWidth: number;
};

function splitsPair(text: string, index: number) {
  return (
    index > 0 &&
    text.charCodeAt(index - 1) >= 0xd800 &&
    text.charCodeAt(index - 1) <= 0xdbff &&
    text.charCodeAt(index) >= 0xdc00 &&
    text.charCodeAt(index) <= 0xdfff
  );
}

function emphasize(before: CodeLine, after: CodeLine) {
  const a = before.text,
    b = after.text;
  let start = 0,
    end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (
    end < Math.min(a.length, b.length) - start &&
    a[a.length - end - 1] === b[b.length - end - 1]
  )
    end++;
  if (splitsPair(a, start) || splitsPair(b, start)) start--;
  if (splitsPair(a, a.length - end) || splitsPair(b, b.length - end)) end--;
  if (start < a.length - end) before.emphasis = [start, a.length - end];
  if (start < b.length - end) after.emphasis = [start, b.length - end];
}

export function prepareFileRows(file: Extract<RepositoryFile, { kind: "text" }>): FileRows {
  const lines = file.text.split("\n", 20002);
  if (lines.at(-1) === "") lines.pop();
  const result: FileRows = {
    rows: [],
    limited: lines.length > 20000,
    longLines: false,
    split: file.view === "diff" || file.comparison === "empty" || file.comparison === "unborn",
    added: 0,
    removed: 0,
    beforeWidth: 0,
    afterWidth: 0,
  };
  let old = 0,
    next = 0,
    inHunk = false;
  let removed: CodeLine[] = [],
    added: CodeLine[] = [];
  let notes: Extract<CodeRow, { kind: "note" }>[] = [];
  let lastSide: "before" | "after" | "both" = "after";
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const before = removed[i] ?? null,
        after = added[i] ?? null;
      if (before && after) emphasize(before, after);
      result.rows.push({ kind: "lines", before, after, changed: true });
    }
    result.rows.push(...notes);
    removed = [];
    added = [];
    notes = [];
  }
  function clip(line: string) {
    result.longLines ||= line.length > 4000;
    return line.length > 4000
      ? `${line.slice(0, splitsPair(line, 4000) ? 3999 : 4000)} … [line clipped]`
      : line;
  }
  for (const line of lines.slice(0, 20000)) {
    if (file.view === "file") {
      result.rows.push({
        kind: "lines",
        before: null,
        after: { text: clip(line), number: ++next },
        changed: file.comparison === "empty" || file.comparison === "unborn",
      });
      if (file.comparison === "empty" || file.comparison === "unborn") result.added++;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      const hidden = Math.max(0, Number(hunk[1]) - Math.max(old, 1));
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      result.rows.push({ kind: "hunk", before: old, after: next, ...(hidden ? { hidden } : {}) });
    } else if (inHunk && line.startsWith("-")) {
      if (added.length) flush();
      removed.push({ text: clip(line.slice(1)), number: old++ });
      result.removed++;
      lastSide = "before";
    } else if (inHunk && line.startsWith("+")) {
      added.push({ text: clip(line.slice(1)), number: next++ });
      result.added++;
      lastSide = "after";
    } else if (inHunk && line.startsWith(" ")) {
      flush();
      lastSide = "both";
      const text = clip(line.slice(1));
      result.rows.push({
        kind: "lines",
        before: { text, number: old++ },
        after: { text, number: next++ },
        changed: false,
      });
    } else if (inHunk && line.startsWith("\\")) {
      notes.push({ kind: "note", text: line.slice(2), side: lastSide });
    } else {
      flush();
      inHunk = false;
    }
  }
  flush();
  for (const row of result.rows) {
    if (row.kind !== "lines") continue;
    result.beforeWidth = Math.max(
      result.beforeWidth,
      row.before?.text.replace(/\t/g, "    ").length ?? 0,
    );
    result.afterWidth = Math.max(
      result.afterWidth,
      row.after?.text.replace(/\t/g, "    ").length ?? 0,
    );
  }
  return result;
}
