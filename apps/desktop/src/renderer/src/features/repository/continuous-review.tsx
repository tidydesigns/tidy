import { Button } from "@tidy/ui/button";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  RepositoryChange,
  RepositoryFile,
} from "../../../../shared/contracts/repository-files";
import { CodeCell, codeRowKind } from "./code-cell";
import type { FileRows } from "./file-rows";
import FileRowsWorker from "./file-rows.worker?worker";
import { FileIcon, RepositoryIcon } from "./repository-icons";
import {
  offsetIndex,
  reviewBodyOffset,
  reviewHeaderHeight,
  reviewOffsets,
  reviewPlaceholderHeight,
  reviewRange,
  reviewRowLayout,
} from "./review-layout";
import type { RepositoryAPI, RepositoryInvalidation } from "./use-repository-files";
import "./continuous-review.css";

type Entry = {
  file: RepositoryFile;
  change: RepositoryChange;
  result?: FileRows;
  revision: number;
  measured: Map<number, number>;
  measurementKey: string;
};
type Layout = {
  change: RepositoryChange;
  entry?: Entry;
  rows?: Float64Array;
  height: number;
  bodyOffset?: number;
  notice?: string;
  wrap?: boolean;
};
type Anchor = { path: string; row: number | null; within: number; top: number };
const unavailableText = {
  filtered: "This file uses external Git filters. Review it in your editor.",
  binary: "Binary or non-UTF-8 file. A text preview is unavailable.",
  oversized:
    "This file exceeds the preview limit (1 MiB file or 2 MiB diff). Open it in your editor.",
  symlink: "Symbolic links are shown without following their targets.",
  unsupported: "This file type cannot be previewed.",
  missing: "This file is no longer available.",
  conflict: "Resolve this file’s merge conflicts in your editor before reviewing its diff.",
} satisfies Record<Extract<RepositoryFile, { kind: "unavailable" }>["reason"], string>;

export function ContinuousReview({
  api,
  projectId,
  changes,
  selected,
  reveal,
  active,
  revision,
  onSelect,
  comparison,
  refreshing,
  loading,
  onRefresh,
}: {
  api: RepositoryAPI;
  projectId: string;
  changes: readonly RepositoryChange[];
  selected: string | null;
  reveal: number;
  active: boolean;
  revision: RepositoryInvalidation;
  onSelect(path: string): void;
  comparison: string;
  refreshing: boolean;
  loading: boolean;
  onRefresh(): void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 0 });
  const currentViewport = useRef(viewport);
  currentViewport.current = viewport;
  const [tick, setTick] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [workerAttempt, setWorkerAttempt] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const cache = useRef(new Map<string, Entry>());
  const errors = useRef(new Map<string, string>());
  const anchor = useRef<Anchor | null>(null);
  const pendingReveal = useRef<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const workerJob = useRef<{
    id: number;
    resolve(result: FileRows): void;
    reject(error: Error): void;
  } | null>(null);
  const serial = useRef(0);
  const generation = useRef(0);
  const running = useRef(false);
  const mounted = useRef(false);
  const wanted = useRef<string[]>([]);
  const attempted = useRef(new Set<string>());
  const demandKey = useRef("");
  const projectScope = useRef(projectId);
  const processedRevision = useRef(revision.id);
  const current = useRef({ api, projectId, changes, revision, active });
  current.current = { api, projectId, changes, revision, active };
  const geometry = useMemo(() => {
    const key = `${viewport.width}:${wrap}`;
    const layouts: Layout[] = changes.map((change) => {
      const entry = cache.current.get(change.path);
      if (collapsed.has(change.path)) return { change, entry, height: reviewHeaderHeight };
      if (!entry) return { change, height: reviewPlaceholderHeight };
      if (entry.file.kind === "unavailable") return { change, entry, height: 112 };
      const result = entry.result;
      if (!result) return { change, entry, height: reviewPlaceholderHeight };
      const measurementKey = `${key}:${result.split}`;
      if (entry.measurementKey !== measurementKey) {
        entry.measured = new Map();
        entry.measurementKey = measurementKey;
      }
      const {
        offsets: rows,
        wrap: effectiveWrap,
        limited,
      } = reviewRowLayout(result.rows, viewport.width, result.split, wrap, entry.measured);
      const notice =
        errors.current.get(change.path) ||
        (limited
          ? "Wrapped preview limited. Widen the panel or turn off line wrapping to see more."
          : result.limited || result.longLines
            ? `${result.limited ? "Preview limited to 20,000 input lines. " : ""}${result.longLines ? "Lines longer than 4,000 characters are clipped." : ""}`
            : "");
      const bodyOffset = reviewHeaderHeight + (notice ? 24 : 0);
      const height = bodyOffset + Math.max(24, rows[rows.length - 1]) + (effectiveWrap ? 0 : 16);
      return { change, entry, rows, height, bodyOffset, notice, wrap: effectiveWrap };
    });
    const width = layouts.reduce(
      (maximum, item) =>
        item.wrap === false && item.entry?.result
          ? Math.max(
              maximum,
              Math.max(item.entry.result.beforeWidth, item.entry.result.afterWidth) *
                8 *
                (item.entry.result.split ? 2 : 1) +
                240,
            )
          : maximum,
      viewport.width,
    );
    return { layouts, offsets: reviewOffsets(layouts.map((item) => item.height)), width };
  }, [changes, tick, viewport.width, wrap, collapsed]);
  const latestGeometry = useRef(geometry);
  latestGeometry.current = geometry;
  const saveAnchor = () => {
    const node = scroll.current;
    const value = latestGeometry.current;
    if (!node || !value.layouts.length) return;
    const index = offsetIndex(value.offsets, node.scrollTop);
    const item = value.layouts[index];
    const relative = node.scrollTop - value.offsets[index];
    const row =
      item.rows && relative >= (item.bodyOffset ?? reviewBodyOffset)
        ? offsetIndex(item.rows, relative - (item.bodyOffset ?? reviewBodyOffset))
        : null;
    anchor.current = {
      path: item.change.path,
      row,
      top: node.scrollTop,
      within:
        relative -
        (row === null ? 0 : (item.bodyOffset ?? reviewBodyOffset) + (item.rows?.[row] ?? 0)),
    };
  };
  const publish = () => {
    if (!mounted.current) return;
    saveAnchor();
    setTick((value) => value + 1);
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;
  const drain = useRef<() => void>(() => {});
  drain.current = () => {
    if (running.current || !mounted.current || !current.current.active) return;
    const context = current.current;
    const path = wanted.current.find(
      (path) =>
        cache.current.get(path)?.revision !== context.revision.id &&
        !errors.current.has(path) &&
        !attempted.current.has(path),
    );
    if (!path) return;
    wanted.current = wanted.current.filter((candidate) => candidate !== path);
    const change = context.changes.find((change) => change.path === path);
    if (!change) return;
    running.current = true;
    attempted.current.add(path);
    const requestGeneration = generation.current;
    const valid = () =>
      mounted.current &&
      requestGeneration === generation.current &&
      current.current.projectId === context.projectId &&
      current.current.active &&
      current.current.revision === context.revision &&
      current.current.changes === context.changes;
    void (async () => {
      try {
        const file = await context.api.repositoryFile(
          context.projectId,
          path,
          change.previousPath ?? undefined,
        );
        if (!valid()) return;
        let result: FileRows | undefined;
        if (file.kind === "text") {
          const parser = worker.current;
          if (!parser) throw new Error("Could not prepare this preview.");
          result = await new Promise<FileRows>((resolve, reject) => {
            const id = ++serial.current;
            workerJob.current = { id, resolve, reject };
            parser.postMessage({ id, file, path });
          });
          if (result.rows[0]?.kind === "hunk" && !result.rows[0].hidden)
            result = { ...result, rows: result.rows.slice(1) };
        }
        if (!valid()) return;
        const values = cache.current;
        values.delete(path);
        values.set(path, {
          file,
          change,
          result,
          revision: context.revision.id,
          measured: new Map(),
          measurementKey: "",
        });
        let bytes = 0,
          rows = 0;
        for (const entry of values.values()) {
          bytes += entry.file.kind === "text" ? entry.file.text.length : 0;
          rows += entry.result?.rows.length ?? 0;
        }
        for (const [key, entry] of values) {
          if (values.size <= 24 && bytes <= 4 * 1024 * 1024 && rows <= 60000) break;
          values.delete(key);
          bytes -= entry.file.kind === "text" ? entry.file.text.length : 0;
          rows -= entry.result?.rows.length ?? 0;
        }
        publishRef.current();
      } catch (cause) {
        if (valid()) {
          errors.current.set(
            path,
            cause instanceof Error ? cause.message : "Could not read this file.",
          );
          const oldest = errors.current.keys().next().value;
          if (errors.current.size > 128 && oldest !== undefined) errors.current.delete(oldest);
          publishRef.current();
        }
      } finally {
        running.current = false;
        drain.current();
      }
    })();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      wanted.current = [];
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let parser: Worker;
    try {
      parser = new FileRowsWorker();
    } catch {
      worker.current = null;
      drain.current();
      return;
    }
    worker.current = parser;
    parser.onmessage = (event: MessageEvent<{ id: number; result: FileRows }>) => {
      const job = workerJob.current;
      if (!job || job.id !== event.data.id) return;
      workerJob.current = null;
      job.resolve(event.data.result);
    };
    const failed = () => {
      parser.terminate();
      if (worker.current === parser) worker.current = null;
      const job = workerJob.current;
      workerJob.current = null;
      job?.reject(new Error("Could not prepare this preview."));
    };
    parser.onerror = failed;
    parser.onmessageerror = failed;
    drain.current();
    return () => {
      generation.current++;
      parser.terminate();
      if (worker.current === parser) worker.current = null;
      const job = workerJob.current;
      workerJob.current = null;
      job?.reject(new Error("Preview closed."));
    };
  }, [active, projectId, workerAttempt]);
  useLayoutEffect(() => {
    generation.current++;
    errors.current.clear();
    attempted.current.clear();
    wanted.current = [];
    if (projectScope.current !== projectId) {
      projectScope.current = projectId;
      cache.current.clear();
      selection.current = null;
      setTick((value) => value + 1);
    }
    const retained = new Map(changes.map((change) => [change.path, change]));
    for (const [path, entry] of cache.current) {
      const change = retained.get(path);
      if (!change) cache.current.delete(path);
      else if (
        entry.change.previousPath !== change.previousPath ||
        entry.change.filtered !== change.filtered
      )
        entry.revision = -1;
      else if (
        revision.id === processedRevision.current + 1 &&
        entry.revision === processedRevision.current &&
        revision.paths &&
        !revision.paths.some(
          (parent) => !parent || path === parent || path.startsWith(`${parent}/`),
        )
      )
        entry.revision = revision.id;
    }
    processedRevision.current = revision.id;
  }, [revision, projectId, changes]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !active) return;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      if (node.clientWidth !== currentViewport.current.width) saveAnchor();
      setViewport((previous) => {
        const next = { top: node.scrollTop, height: node.clientHeight, width: node.clientWidth };
        return previous.top === next.top &&
          previous.height === next.height &&
          previous.width === next.width
          ? previous
          : next;
      });
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure);
    };
    const cancelReveal = () => {
      pendingReveal.current = null;
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    node.addEventListener("scroll", schedule, { passive: true });
    node.addEventListener("wheel", cancelReveal, { passive: true });
    node.addEventListener("pointerdown", cancelReveal);
    node.addEventListener("keydown", cancelReveal);
    measure();
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", schedule);
      node.removeEventListener("wheel", cancelReveal);
      node.removeEventListener("pointerdown", cancelReveal);
      node.removeEventListener("keydown", cancelReveal);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [active]);
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = null;
    const node = scroll.current;
    if (!saved || !node || Math.abs(node.scrollTop - saved.top) >= 1) return;
    const index = geometry.layouts.findIndex((item) => item.change.path === saved.path);
    if (index < 0) return;
    const item = geometry.layouts[index];
    const rowTop =
      saved.row !== null && item.rows && item.rows.length > 1
        ? (item.bodyOffset ?? reviewBodyOffset) +
          item.rows[Math.min(saved.row, item.rows.length - 2)]
        : 0;
    node.scrollTop = geometry.offsets[index] + rowTop + saved.within;
    setViewport((value) =>
      value.top === node.scrollTop ? value : { ...value, top: node.scrollTop },
    );
  }, [geometry]);
  const selection = useRef<{ path: string | null; reveal: number } | null>(null);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (
      !active ||
      !node ||
      (selection.current?.path === selected && selection.current.reveal === reveal)
    )
      return;
    selection.current = { path: selected, reveal };
    pendingReveal.current = null;
    const index = changes.findIndex((change) => change.path === selected);
    if (index < 0) return;
    pendingReveal.current = selected;
    anchor.current = null;
    node.scrollTop = geometry.offsets[index];
    setViewport((value) => ({ ...value, top: node.scrollTop }));
    if (selected)
      setCollapsed((previous) => {
        if (!previous.has(selected)) return previous;
        const next = new Set(previous);
        next.delete(selected);
        return next;
      });
  }, [selected, reveal, active, changes, geometry]);
  useLayoutEffect(() => {
    const path = pendingReveal.current;
    const node = scroll.current;
    if (!path || !node || !active) return;
    const index = changes.findIndex((change) => change.path === path);
    if (index < 0) {
      pendingReveal.current = null;
      return;
    }
    anchor.current = null;
    node.scrollTop = geometry.offsets[index];
    setViewport((value) =>
      value.top === node.scrollTop ? value : { ...value, top: node.scrollTop },
    );
    if (
      currentViewport.current.width === node.clientWidth &&
      (cache.current.has(path) || errors.current.has(path))
    )
      pendingReveal.current = null;
  }, [geometry, active, changes]);
  const range = reviewRange(geometry.offsets, viewport.top, viewport.height, viewport.height);
  const visibleRange = reviewRange(geometry.offsets, viewport.top, viewport.height, 0);
  const candidates = geometry.layouts
    .slice(range.start, range.end)
    .filter((item) => !collapsed.has(item.change.path));
  const visiblePaths = new Set(
    geometry.layouts.slice(visibleRange.start, visibleRange.end).map((item) => item.change.path),
  );
  const paths = [
    ...candidates.filter((item) => visiblePaths.has(item.change.path)),
    ...candidates.filter((item) => !visiblePaths.has(item.change.path)),
  ]
    .slice(0, 24)
    .map((item) => item.change.path);
  const pathKey = JSON.stringify(paths);
  const latestPaths = useRef(paths);
  latestPaths.current = paths;
  useEffect(() => {
    if (!active) {
      wanted.current = [];
      attempted.current.clear();
      return;
    }
    const nextDemandKey = `${projectId}:${revision.id}:${pathKey}`;
    if (demandKey.current !== nextDemandKey) {
      demandKey.current = nextDemandKey;
      attempted.current.clear();
    }
    const queue = [...latestPaths.current];
    const requested = pendingReveal.current ?? selected;
    if (requested && (queue.includes(requested) || pendingReveal.current)) {
      wanted.current = queue.filter((path) => path !== requested);
      wanted.current.unshift(requested);
    } else {
      wanted.current = queue;
    }
    drain.current();
  }, [pathKey, revision, active, selected, reveal, projectId, changes, tick]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !wrap || !active) return;
    let frame: number | undefined;
    const pending = new Map<Element, number>();
    const apply = () => {
      frame = undefined;
      let changed = false;
      for (const [element, size] of pending) {
        const path = element.getAttribute("data-path");
        const index = Number(element.getAttribute("data-row"));
        const entry = path ? cache.current.get(path) : undefined;
        const fileIndex = path
          ? geometry.layouts.findIndex((item) => item.change.path === path)
          : -1;
        const layout = geometry.layouts[fileIndex];
        const estimate = layout?.wrap ? layout.rows : undefined;
        if (
          !entry ||
          !estimate ||
          size <= 0 ||
          Math.abs(estimate[index + 1] - estimate[index] - size) < 1
        )
          continue;
        entry.measured.set(index, size);
        changed = true;
      }
      pending.clear();
      if (changed) publishRef.current();
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        pending.set(
          entry.target,
          Math.max(24, Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height)),
        );
      if (frame === undefined) frame = requestAnimationFrame(apply);
    });
    for (const row of node.querySelectorAll("[data-review-row]")) observer.observe(row);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [geometry, viewport.top, viewport.height, wrap, active]);
  return (
    <>
      <div className="repository-review-toolbar">
        <div className="repository-review-identity">
          <span className="repository-review-count">
            {changes.length} {changes.length === 1 ? "file" : "files"}
          </span>
          <span className="repository-review-comparison">{comparison}</span>
        </div>
        <Button
          className="quiet-button repository-icon-button"
          onClick={onRefresh}
          aria-label="Refresh repository"
          title="Refresh repository"
          aria-busy={refreshing}
        >
          <RepositoryIcon name="refresh" />
        </Button>
        <Button
          className="quiet-button repository-icon-button"
          aria-label="Wrap lines"
          title="Wrap lines"
          aria-pressed={wrap}
          onClick={() => {
            saveAnchor();
            setWrap((value) => !value);
          }}
        >
          <RepositoryIcon name="wrap" />
        </Button>
      </div>
      <div
        ref={scroll}
        className="repository-review-scroll"
        role="region"
        aria-label="Changed files review"
        tabIndex={0}
      >
        {!changes.length && (
          <p className="repository-review-status" role="status">
            {loading ? "Reading changes…" : "No changed files"}
          </p>
        )}
        <div
          className="repository-review-canvas"
          style={{
            height: geometry.offsets[geometry.offsets.length - 1],
            minWidth: geometry.width,
          }}
        >
          {geometry.layouts.slice(range.start, range.end).map((item, offset) => {
            const index = range.start + offset;
            const { change, entry } = item;
            const result = entry?.result;
            const file = entry?.file;
            const isCollapsed = collapsed.has(change.path);
            const rowRange = item.rows
              ? reviewRange(
                  item.rows,
                  viewport.top - geometry.offsets[index] - (item.bodyOffset ?? reviewBodyOffset),
                  viewport.height,
                )
              : { start: 0, end: 0 };
            const sides = result?.split ? (["before", "after"] as const) : (["after"] as const);
            const error = errors.current.get(change.path);
            return (
              <section
                className="repository-review-section"
                key={change.path}
                style={{ top: geometry.offsets[index], height: item.height }}
                aria-label={change.path}
              >
                <div
                  className="repository-review-heading"
                  data-selected={selected === change.path}
                  style={{ width: viewport.width || undefined }}
                >
                  <Button
                    className="quiet-button repository-icon-button"
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${change.path}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => {
                      saveAnchor();
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(change.path)) next.delete(change.path);
                        else next.add(change.path);
                        return next;
                      });
                    }}
                  >
                    <RepositoryIcon name="chevron" />
                  </Button>
                  <FileIcon name={change.path} />
                  <Button
                    className="quiet-button repository-file-path"
                    title={
                      change.previousPath ? `${change.previousPath} → ${change.path}` : change.path
                    }
                    aria-label={`${change.path}, ${change.status}`}
                    onClick={() => onSelect(change.path)}
                  >
                    {change.path}
                  </Button>
                  {error && (
                    <Button
                      className="quiet-button"
                      onClick={() => {
                        errors.current.delete(change.path);
                        attempted.current.delete(change.path);
                        wanted.current.unshift(change.path);
                        publishRef.current();
                        if (!worker.current) setWorkerAttempt((value) => value + 1);
                        else drain.current();
                      }}
                    >
                      Retry
                    </Button>
                  )}
                  {result && (
                    <span className="repository-change-count">
                      <span data-kind="added">+{result.added}</span>
                      <span data-kind="removed">−{result.removed}</span>
                    </span>
                  )}
                  {change.status !== "modified" && (
                    <span className="repository-review-file-state" data-status={change.status}>
                      {change.status === "typechange" ? "Type changed" : change.status}
                    </span>
                  )}
                </div>
                {!isCollapsed &&
                  (file?.kind === "unavailable" ? (
                    <p className="repository-review-status" role="status">
                      {unavailableText[file.reason]}
                    </p>
                  ) : result && item.rows ? (
                    <>
                      {item.notice && (
                        <p className="repository-review-notice" role="status" title={item.notice}>
                          {item.notice}
                        </p>
                      )}
                      <div
                        className="repository-review-body"
                        data-wrap={item.wrap ?? wrap}
                        style={{ height: item.height - (item.bodyOffset ?? reviewBodyOffset) }}
                      >
                        <div
                          className="repository-review-rows"
                          style={{
                            height: item.rows[item.rows.length - 1],
                          }}
                        >
                          {result.rows.slice(rowRange.start, rowRange.end).map((row, rowOffset) => {
                            const rowIndex = rowRange.start + rowOffset;
                            return (
                              <div
                                key={rowIndex}
                                className="repository-wrapped-row"
                                data-review-row=""
                                data-path={change.path}
                                data-row={rowIndex}
                                data-split={result.split}
                                style={{ top: item.rows?.[rowIndex] }}
                              >
                                {sides.map((side) => (
                                  <div
                                    key={side}
                                    className="repository-code-row"
                                    data-kind={codeRowKind(row, side)}
                                  >
                                    {!(result.split && side === "after" && row.kind === "hunk") && (
                                      <CodeCell row={row} side={side} />
                                    )}
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                          {!result.rows.length && (
                            <p className="repository-review-status">
                              {file?.kind === "text" && file.deleted
                                ? "Deleted file"
                                : change.status === "added" || change.status === "untracked"
                                  ? "Empty file"
                                  : "No text changes"}
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="repository-review-status" role="status">
                      <span>{error || "Loading preview…"}</span>
                    </div>
                  ))}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
