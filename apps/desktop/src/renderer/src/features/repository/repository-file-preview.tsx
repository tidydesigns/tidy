import type { FileLineTarget } from "./file-navigation";
import { fileLineTarget } from "./file-line-target";
import { Button } from "@tidy/ui/button";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RepositoryFile } from "../../../../shared/contracts/repository-files";
import type { FileRows } from "./file-rows";
import { useVirtualWindow } from "./virtual-window";
import { useMeasuredWindow, rowAtOffset } from "./measured-window";
import { CodeCell, codeRowKind, fileColumnRange } from "./code-cell";
import { RepositoryIcon } from "./repository-icons";
import { rememberScroll } from "./use-repository-scroll";
import FileRowsWorker from "./file-rows.worker?worker";

const emptyRows: FileRows["rows"] = [];
const unavailableText = {
  filtered: "This file needs a tool that isn't available here.",
  binary: "This file can't be shown as text.",
  oversized: "This file is too large to preview.",
  symlink: "This file points to a missing file or a file outside this project.",
  unsupported: "This file type cannot be previewed.",
  missing: "This file isn't available in this folder. It may have moved or been deleted.",
  conflict: "This file has unresolved changes.",
} satisfies Record<Extract<RepositoryFile, { kind: "unavailable" }>["reason"], string>;

export const FileContent = memo(function FileContent({
  file,
  path,
  active,
  visible,
  positions,
  target,
  onRetry,
}: {
  onRetry?: () => void;
  target?: FileLineTarget;
  visible: boolean;
  positions: Map<string, number>;
  file: RepositoryFile;
  path: string;
  active: boolean;
}) {
  const [prepared, setPrepared] = useState<{
    file: RepositoryFile;
    path: string;
    result: FileRows;
  }>();
  const preparedCache = useRef(
    new Map<RepositoryFile, { file: RepositoryFile; path: string; result: FileRows }>(),
  );
  const workerRef = useRef<Worker | null>(null);
  const workerBusy = useRef(false);
  const pendingParse = useRef<{
    id: number;
    file: Extract<RepositoryFile, { kind: "text" }>;
    path: string;
  } | null>(null);
  const request = useRef<{ id: number; file: RepositoryFile; path: string }>({
    id: 0,
    file,
    path,
  });
  const available = preparedCache.current.get(file) ?? prepared;
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(true);
  const measured = useMeasuredWindow(
    available?.result.rows ?? emptyRows,
    available?.result.split ?? false,
  );
  const virtual = useVirtualWindow(available?.result.rows.length ?? 0, 24);
  const pairedPane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    setError("");
    const worker = new FileRowsWorker();
    workerRef.current = worker;
    workerBusy.current = false;
    pendingParse.current = null;
    worker.onmessage = (event: MessageEvent<{ id: number; result: FileRows }>) => {
      const current = request.current;
      workerBusy.current = false;
      if (event.data.id === current.id) {
        const value = {
          file: current.file,
          path: current.path,
          result: event.data.result,
        };
        const cache = preparedCache.current;
        cache.set(current.file, value);
        let rows = [...cache.values()].reduce((sum, item) => sum + item.result.rows.length, 0);
        for (const [key, entry] of cache) {
          if (cache.size <= 12 && rows <= 60000) break;
          cache.delete(key);
          rows -= entry.result.rows.length;
        }
        setPrepared(value);
        setError("");
      }
      const next = pendingParse.current;
      pendingParse.current = null;
      if (next) {
        workerBusy.current = true;
        worker.postMessage(next);
      }
    };
    worker.onerror = () => {
      workerBusy.current = false;
      pendingParse.current = null;
      setError("Could not prepare this preview.");
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [active, attempt]);
  useEffect(() => {
    request.current = { id: request.current.id + 1, file, path };
    pendingParse.current = null;
    if (!active || file.kind !== "text" || preparedCache.current.has(file)) return;
    const next = { id: request.current.id, file, path };
    if (workerBusy.current) pendingParse.current = next;
    else if (workerRef.current) {
      workerBusy.current = true;
      workerRef.current.postMessage(next);
    }
  }, [file, path, active, attempt]);
  useLayoutEffect(() => {
    const node = wrap ? measured.ref.current : virtual.ref.current;
    if (active && visible && node && available?.file === file) {
      const row = positions.get(`file-wrap-row:${path}`) ?? 0;
      const top = wrap
        ? (measured.offsets[Math.min(row, measured.offsets.length - 1)] ?? 0)
        : (positions.get(`file:${path}`) ?? 0);
      const left = positions.get(`file-x:${path}`) ?? 0;
      for (const pane of [node, pairedPane.current]) {
        if (!pane) continue;
        pane.scrollTop = top;
        pane.scrollLeft = left;
      }
    }
  }, [file, available, path, positions, active, visible, wrap]);
  const targetRow = useMemo(
    () =>
      target?.path === path && available?.file === file
        ? fileLineTarget(available.result.rows, target.line)
        : null,
    [target?.path, target?.line, path, available, file],
  );
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const node = wrap ? measured.ref.current : virtual.ref.current;
    if (
      !active ||
      !visible ||
      !target ||
      !targetRow ||
      !node ||
      node.clientHeight === 0 ||
      (wrap && measured.width === 0)
    )
      return;
    const key = `${target.id}:${wrap}`;
    if (revealed.current === key) return;
    let frame: number;
    let stable = 0;
    const cancel = () => {
      revealed.current = key;
      cancelAnimationFrame(frame);
    };
    const reveal = () => {
      const number = node.querySelector<HTMLElement>(`[aria-label="New line ${targetRow.line}"]`);
      const row = number?.closest<HTMLElement>(".repository-code-row");
      const destination = row?.querySelector<HTMLElement>("[data-file-column]") ?? number;
      if (!destination) {
        const top = wrap ? measured.offsets[targetRow.index] : targetRow.index * 24;
        node.scrollTop = Math.max(0, top - node.clientHeight / 3);
        stable = 0;
      } else {
        const area = node.getBoundingClientRect();
        const character = destination.getBoundingClientRect();
        const inside =
          character.top >= area.top &&
          character.bottom <= area.bottom &&
          character.left >= area.left &&
          character.right <= area.right;
        stable = inside ? stable + 1 : 0;
        if (!inside) {
          node.scrollTop += character.top - area.top - node.clientHeight / 3;
          if (character.left < area.left || character.right > area.right)
            node.scrollLeft += character.left - area.left - node.clientWidth / 3;
        }
        if (stable >= 2) {
          revealed.current = key;
          rememberScroll(positions, `file-wrap-row:${path}`, targetRow.index);
          rememberScroll(positions, `file:${path}`, node.scrollTop);
          return;
        }
      }
      frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    for (const event of ["wheel", "pointerdown", "touchstart", "keydown"])
      node.addEventListener(event, cancel, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      for (const event of ["wheel", "pointerdown", "touchstart", "keydown"])
        node.removeEventListener(event, cancel);
    };
  }, [
    target,
    targetRow,
    active,
    visible,
    wrap,
    measured.offsets,
    measured.start,
    measured.end,
    measured.width,
    virtual.start,
    positions,
    path,
  ]);
  const selectedRow = available?.result.rows[targetRow?.index ?? -1];
  const columnAvailable = Boolean(
    targetRow?.exact &&
    target?.column &&
    selectedRow?.kind === "lines" &&
    selectedRow.after &&
    fileColumnRange(selectedRow.after, target.column),
  );
  const columnClipped = Boolean(
    !columnAvailable &&
    target?.column &&
    selectedRow?.kind === "lines" &&
    selectedRow.after?.sourceLength &&
    target.column <= selectedRow.after.sourceLength,
  );
  const highlightsRow = (index: number) => {
    if (!targetRow || !target) return false;
    if (!targetRow.exact || !target.endLine) return index === targetRow.index;
    const row = available?.result.rows[index];
    return (
      row?.kind === "lines" &&
      Boolean(row.after && row.after.number >= target.line && row.after.number <= target.endLine)
    );
  };
  if (file.kind === "unavailable")
    return (
      <div className="repository-empty" role="status">
        <p>{unavailableText[file.reason]}</p>
        {file.reason === "missing" && onRetry && (
          <Button className="quiet-button" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  const result = available?.result;
  const displayedFile = available?.file.kind === "text" ? available.file : file;
  const panes = result?.split ? (["before", "after"] as const) : (["after"] as const);
  function locationLabel() {
    if (!target || !targetRow) return "This file is empty.";
    const unavailable =
      result?.limited || displayedFile.truncated ? "is outside this preview" : "is unavailable";
    if (!targetRow.exact)
      return `Line ${target.line} ${unavailable}. Showing line ${targetRow.line}.`;
    if (target.endLine && target.endLine > target.line) {
      const complete = result?.rows.some(
        (row) => row.kind === "lines" && row.after?.number === target.endLine,
      );
      return complete
        ? `Lines ${target.line} to ${target.endLine}`
        : `Line ${target.endLine} ${unavailable}. Showing available lines.`;
    }
    if (!target.column) return `Line ${targetRow.line}`;
    if (columnAvailable) return `Line ${targetRow.line}, column ${target.column}`;
    return `Line ${targetRow.line}. Column ${target.column} ${columnClipped ? "is outside this preview" : "is unavailable"}.`;
  }

  return (
    <>
      <div
        className="repository-preview-summary"
        role="status"
        title="Working tree comparisons include staged and unstaged changes."
      >
        <span>
          {error ||
            (available?.file !== file
              ? `Preparing preview…${available ? ` Showing ${available.path}.` : ""}`
              : result?.split
                ? displayedFile.comparison === "unborn"
                  ? "No commits yet · empty baseline"
                  : displayedFile.comparison === "empty"
                    ? "Untracked file · empty baseline"
                    : "Working tree vs HEAD"
                : displayedFile.comparison === "head"
                  ? "Unchanged from HEAD"
                  : displayedFile.truncated
                    ? "Current file · preview limited"
                    : "Current file")}
        </span>
        {target && target.path === path && available?.file === file && (
          <span className="min-w-0 text-xs text-muted-ink">{locationLabel()}</span>
        )}
        {error && (
          <Button
            type="button"
            className="quiet-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry preview
          </Button>
        )}
        <div className="repository-preview-actions">
          {result?.split && (
            <span className="repository-change-count">
              <span data-kind="added">+{result.added}</span>
              <span data-kind="removed">−{result.removed}</span>
            </span>
          )}
          <Button
            className="quiet-button repository-icon-button"
            aria-label="Wrap lines"
            title="Wrap lines"
            aria-pressed={wrap}
            onClick={() => {
              const node = wrap ? measured.ref.current : virtual.ref.current;
              if (node) {
                const row = wrap
                  ? rowAtOffset(measured.offsets, node.scrollTop)
                  : Math.floor(node.scrollTop / 24);
                rememberScroll(positions, `file-wrap-row:${path}`, row);
                rememberScroll(positions, `file:${path}`, row * 24);
              }
              setWrap((value) => !value);
            }}
          >
            <RepositoryIcon name="wrap" />
          </Button>
        </div>
      </div>
      {result && (result.limited || result.longLines) && (
        <p className="repository-limit">
          {result.limited ? "Preview limited to 20,000 input lines. " : ""}
          {result.longLines ? "Lines longer than 4,000 characters are clipped." : ""}
        </p>
      )}
      <div className="repository-diff-labels" data-split={result?.split}>
        {panes.map((side) => (
          <div key={side}>
            <span className="repository-version-dot" data-side={side} />
            {side === "before"
              ? displayedFile.comparison === "empty" || displayedFile.comparison === "unborn"
                ? "Empty baseline"
                : "HEAD"
              : displayedFile.deleted
                ? "Deleted file"
                : "Working tree"}
          </div>
        ))}
      </div>
      <div
        className="repository-code"
        role="group"
        aria-label={`Preview of ${available?.path ?? path}`}
        data-split={result?.split}
        data-wrap={wrap}
      >
        {wrap ? (
          <div
            ref={measured.attach}
            className="repository-wrapped-code"
            tabIndex={0}
            role="region"
            aria-label={
              result?.split
                ? "Side-by-side comparison, original on the left, working tree on the right"
                : "File contents"
            }
            onScroll={(event) => {
              if (active && visible && available && event.currentTarget.clientHeight > 0)
                rememberScroll(
                  positions,
                  `file-wrap-row:${available.path}`,
                  rowAtOffset(measured.offsets, event.currentTarget.scrollTop),
                );
            }}
          >
            <div className="repository-wrapped-canvas" style={{ height: measured.total }}>
              {result?.rows.slice(measured.start, measured.end).map((row, offset) => {
                const index = measured.start + offset;
                return (
                  <div
                    className="repository-wrapped-row"
                    data-row={index}
                    data-split={result.split}
                    key={index}
                    style={{ top: measured.offsets[index] }}
                  >
                    {panes.map((side) => (
                      <div
                        className={`repository-code-row ${highlightsRow(index) ? "bg-(--color-hover-surface) ring-1 ring-inset ring-(--color-control-border)" : ""}`}
                        data-highlighted={highlightsRow(index) || undefined}
                        data-kind={codeRowKind(row, side)}
                        key={side}
                      >
                        <CodeCell
                          row={row}
                          side={side}
                          column={
                            targetRow?.exact && targetRow.index === index && columnAvailable
                              ? target?.column
                              : undefined
                          }
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            {available?.file === file && !result?.rows.length && (
              <p className="repository-empty">
                {displayedFile.deleted
                  ? "Deleted file"
                  : displayedFile.view === "diff"
                    ? "No changes"
                    : "Empty file"}
              </p>
            )}
          </div>
        ) : (
          panes.map((side, paneIndex) => (
            <div
              key={side}
              ref={paneIndex === 0 ? virtual.attach : pairedPane}
              className="repository-code-pane"
              tabIndex={0}
              role="region"
              aria-label={
                side === "before"
                  ? "Original lines"
                  : result?.split
                    ? "Changed lines"
                    : "File contents"
              }
              onScroll={(event) => {
                const node = event.currentTarget;
                const other = paneIndex === 0 ? pairedPane.current : virtual.ref.current;
                if (other) {
                  if (Math.abs(other.scrollTop - node.scrollTop) > 1)
                    other.scrollTop = node.scrollTop;
                  if (Math.abs(other.scrollLeft - node.scrollLeft) > 1)
                    other.scrollLeft = node.scrollLeft;
                }
                if (active && visible && available && node.clientHeight > 0) {
                  rememberScroll(positions, `file:${available.path}`, node.scrollTop);
                  rememberScroll(positions, `file-x:${available.path}`, node.scrollLeft);
                }
              }}
            >
              <div
                className="repository-code-canvas"
                style={{
                  height: (result?.rows.length ?? 0) * 24,
                  minWidth: `max(100%, calc(${Math.max(result?.beforeWidth ?? 0, result?.afterWidth ?? 0)}ch + var(--repository-number-width) + var(--repository-sign-width) + 24px))`,
                }}
              >
                {result?.rows.slice(virtual.start, virtual.end).map((row, offset) => {
                  const index = virtual.start + offset;
                  return (
                    <div
                      key={index}
                      className={`repository-code-row ${highlightsRow(index) ? "bg-(--color-hover-surface) ring-1 ring-inset ring-(--color-control-border)" : ""}`}
                      data-highlighted={highlightsRow(index) || undefined}
                      data-kind={codeRowKind(row, side)}
                      style={{ top: (virtual.start + offset) * 24 }}
                    >
                      <CodeCell
                        row={row}
                        side={side}
                        column={
                          targetRow?.exact && targetRow.index === index && columnAvailable
                            ? target?.column
                            : undefined
                        }
                      />
                    </div>
                  );
                })}
              </div>
              {available?.file === file && !result?.rows.length && (
                <p className="repository-empty">
                  {displayedFile.deleted
                    ? "Deleted file"
                    : displayedFile.view === "diff"
                      ? "No changes"
                      : "Empty file"}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
});
