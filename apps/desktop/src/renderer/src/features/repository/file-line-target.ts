import type { CodeRow } from "./file-rows";

export function fileLineTarget(rows: readonly CodeRow[], line: number) {
  let last = -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.kind !== "lines" || !row.after) continue;
    last = index;
    if (row.after.number >= line)
      return { index, line: row.after.number, exact: row.after.number === line };
  }
  if (last < 0) return null;
  const row = rows[last];
  return row.kind === "lines" && row.after
    ? { index: last, line: row.after.number, exact: false }
    : null;
}
