import { Button } from "@tidy/ui/button";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RepositoryFile } from "../../../../shared/contracts/repository-files";
import type { FileRows } from "./file-rows";
import { useVirtualWindow } from "./virtual-window";
import { useMeasuredWindow, rowAtOffset } from "./measured-window";
import { CodeCell, codeRowKind } from "./code-cell";
import { RepositoryIcon } from "./repository-icons";
import { rememberScroll } from "./use-repository-scroll";
import FileRowsWorker from "./file-rows.worker?worker";

const emptyRows: FileRows["rows"] = [];
const unavailableText = {
  filtered: "This file uses external Git filters. Review its changes in your editor.",
  binary: "Binary or non-UTF-8 file. A text preview is unavailable.",
  oversized:
    "This file exceeds the preview limit (1 MiB file or 2 MiB diff). Open it in your editor.",
  symlink: "Symbolic links are shown without following their targets.",
  unsupported: "This file type cannot be previewed.",
  missing: "This file is no longer available. Refresh to update the file list.",
  conflict: "This file has merge conflicts. Resolve them in your editor before reviewing its diff.",
} satisfies Record<Extract<RepositoryFile, { kind: "unavailable" }>["reason"], string>;

export const FileContent = memo(function FileContent({
  file,
  path,
  active,
  visible,
  positions,
}: {
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
  if (file.kind === "unavailable")
    return (
      <p className="repository-empty" role="status">
        {unavailableText[file.reason]}
      </p>
    );
  const result = available?.result;
  const displayedFile = available?.file.kind === "text" ? available.file : file;
  const panes = result?.split ? (["before", "after"] as const) : (["after"] as const);
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
                  : "File contents")}
        </span>
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
                        className="repository-code-row"
                        data-kind={codeRowKind(row, side)}
                        key={side}
                      >
                        <CodeCell row={row} side={side} />
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
                  return (
                    <div
                      key={virtual.start + offset}
                      className="repository-code-row"
                      data-kind={codeRowKind(row, side)}
                      style={{ top: (virtual.start + offset) * 24 }}
                    >
                      <CodeCell row={row} side={side} />
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
