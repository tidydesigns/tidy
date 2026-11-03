import type { CodeLine, CodeRow } from "./file-rows";

function LineText({ line, column }: { line: CodeLine; column?: number }) {
  const emphasis = column
    ? [Math.min(column - 1, Math.max(0, line.text.length - 1)), Math.min(column, line.text.length)]
    : line.emphasis;
  let offset = 0;
  return (line.tokens ?? [{ text: line.text || " ", classes: "" }]).map((token, index) => {
    const start = offset;
    offset += token.text.length;
    const from = emphasis ? Math.max(start, emphasis[0]) - start : 0;
    const to = emphasis ? Math.min(offset, emphasis[1]) - start : 0;
    return (
      <span className={token.classes || undefined} key={index}>
        {to > from ? (
          <>
            {token.text.slice(0, from)}
            <mark>{token.text.slice(from, to)}</mark>
            {token.text.slice(to)}
          </>
        ) : (
          token.text
        )}
      </span>
    );
  });
}
export function codeRowKind(row: CodeRow, side: "before" | "after") {
  return row.kind !== "lines"
    ? row.kind
    : !row[side]
      ? "empty"
      : row.changed
        ? side === "before"
          ? "removed"
          : "added"
        : "context";
}
export function CodeCell({
  row,
  side,
  column,
}: {
  row: CodeRow;
  side: "before" | "after";
  column?: number;
}) {
  if (row.kind === "hunk")
    return (
      <>
        <span className="repository-line-number">···</span>
        <span
          className="repository-hunk-label"
          title={row.hidden ? "These unchanged lines are outside the diff context." : undefined}
        >
          {row.hidden
            ? `${row.hidden} unchanged ${row.hidden === 1 ? "line" : "lines"}`
            : `Line ${row[side]}`}
        </span>
      </>
    );
  if (row.kind === "note")
    return (
      <span className="repository-newline-note">
        {row.side === "both" || row.side === side ? row.text : ""}
      </span>
    );
  const line = row[side];
  return (
    <>
      <span
        className="repository-line-number"
        aria-label={line ? `${side === "before" ? "Old" : "New"} line ${line.number}` : undefined}
      >
        {line?.number ?? ""}
      </span>
      <span className="repository-line-sign" aria-hidden="true">
        {line && row.changed ? (side === "before" ? "−" : "+") : ""}
      </span>
      <code>{line ? <LineText line={line} column={column} /> : " "}</code>
    </>
  );
}
