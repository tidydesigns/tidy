import type { CodeLine, CodeRow } from "./file-rows";

function LineText({ line }: { line: CodeLine }) {
  let offset = 0;
  return (line.tokens ?? [{ text: line.text || " ", classes: "" }]).map((token, index) => {
    const start = offset;
    offset += token.text.length;
    const from = line.emphasis ? Math.max(start, line.emphasis[0]) - start : 0;
    const to = line.emphasis ? Math.min(offset, line.emphasis[1]) - start : 0;
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
export function CodeCell({ row, side }: { row: CodeRow; side: "before" | "after" }) {
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
      <code>{line ? <LineText line={line} /> : " "}</code>
    </>
  );
}
