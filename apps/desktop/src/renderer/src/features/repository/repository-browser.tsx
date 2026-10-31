import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";
import { Button } from "@tidy/ui/button";
import { useSessionState } from "../../app/session-state";
import { visibleTreeRows, type TreeRow } from "./file-rows";
import { useVirtualWindow } from "./virtual-window";
import { useRepositoryFiles, type RepositoryAPI } from "./use-repository-files";
import { useRepositoryScroll, rememberScroll } from "./use-repository-scroll";
import { FileContent } from "./repository-file-preview";
import { FileIcon, RepositoryIcon } from "./repository-icons";
import "./repository-browser.css";

const navigationSchema = z.object({
  selected: z.string().nullable(),
  expanded: z.array(z.string()).max(64),
  view: z.enum(["files", "changes"]),
});
export function RepositoryBrowser({
  api,
  projectId,
  active,
  surface,
  onOpenSurface,
}: {
  api: RepositoryAPI;
  projectId: string;
  active: boolean;
  surface: "files" | "diff";
  onOpenSurface(surface: "files" | "diff"): void;
}) {
  const [navigation, setNavigation] = useSessionState(`repository:${projectId}`, navigationSchema, {
    selected: null,
    expanded: [],
    view: "files",
  });
  const scrollPositions = useRepositoryScroll(projectId);
  const expanded = useMemo(() => new Set(navigation.expanded), [navigation.expanded]);
  const repository = useRepositoryFiles({
    api,
    projectId,
    active,
    selected: navigation.selected,
    expanded,
  });
  const [focused, setFocused] = useState<string | null>(null);
  const [treeError, setTreeError] = useState("");
  const rows = useMemo<TreeRow[]>(
    () =>
      navigation.view === "files"
        ? visibleTreeRows(repository.directories, expanded)
        : (repository.changes?.changes ?? []).map((change, index, changes) => ({
            path: change.path,
            name: change.path.split("/").at(-1) ?? change.path,
            kind: "file",
            depth: 1,
            position: index + 1,
            siblings: changes.length,
          })),
    [navigation.view, repository.directories, repository.changes, expanded],
  );
  const statuses = useMemo(
    () => new Map(repository.changes?.changes.map((change) => [change.path, change])),
    [repository.changes],
  );
  const folderChanges = useMemo(() => {
    const folders = rows.filter((row) => row.kind === "directory");
    const paths = new Set(folders.map((row) => row.path));
    const depth = folders.reduce((maximum, row) => Math.max(maximum, row.depth), 0);
    const counts = new Map<string, number>();
    for (const change of repository.changes?.changes ?? []) {
      const parts = change.path.split("/");
      for (let index = 1; index < parts.length && index <= depth; index++) {
        const parent = parts.slice(0, index).join("/");
        if (paths.has(parent)) counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
    }
    return counts;
  }, [repository.changes, rows]);
  const changedFiles = repository.changes?.changes ?? [];
  const selectedChange = navigation.selected ? statuses.get(navigation.selected) : undefined;
  const changedIndex = changedFiles.findIndex((change) => change.path === navigation.selected);
  const virtual = useVirtualWindow(rows.length, 28);
  const activeRow =
    rows.find((row) => row.path === focused) ??
    rows.find((row) => row.path === navigation.selected) ??
    rows[0];
  const activeIndex = activeRow ? rows.indexOf(activeRow) : -1;
  const treeRestoration = useRef<{ view: string; top: number; pending: boolean } | null>(null);
  useLayoutEffect(() => {
    const node = virtual.ref.current;
    if (!active || surface !== "files" || !node) {
      treeRestoration.current = null;
      return;
    }
    if (treeRestoration.current?.view !== navigation.view)
      treeRestoration.current = {
        view: navigation.view,
        top: scrollPositions.get(`tree:${navigation.view}`) ?? 0,
        pending: true,
      };
    const restoration = treeRestoration.current;
    if (!restoration.pending) return;
    const loaded =
      navigation.view === "changes"
        ? Boolean(repository.changes)
        : repository.directories.has("") &&
          rows.every(
            (row) =>
              row.kind !== "directory" ||
              !expanded.has(row.path) ||
              repository.directories.has(row.path),
          );
    if (restoration.top <= node.scrollHeight - node.clientHeight || loaded) {
      node.scrollTop = restoration.top;
      restoration.pending = false;
    }
  }, [
    navigation.view,
    surface,
    active,
    rows,
    expanded,
    repository.directories,
    repository.changes,
    scrollPositions,
  ]);
  const typeahead = useRef({ value: "", at: 0 });
  function focusRow(index: number) {
    const row = rows[index];
    if (!row) return;
    setFocused(row.path);
    virtual.reveal(index);
    if (row.kind === "directory") void repository.preload(row.path);
  }
  function toggle(row: TreeRow) {
    setTreeError("");
    if (row.kind !== "directory") {
      setNavigation((current) => ({ ...current, selected: row.path }));
      onOpenSurface("diff");
      return;
    }
    if (!expanded.has(row.path) && expanded.size >= 64) {
      setTreeError("Collapse a folder before expanding more than 64 folders.");
      return;
    }
    setNavigation((current) => ({
      ...current,
      expanded: expanded.has(row.path)
        ? current.expanded.filter((path) => path !== row.path)
        : [...current.expanded, row.path],
    }));
    void repository.preload(row.path);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!activeRow || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown") focusRow(Math.min(rows.length - 1, activeIndex + 1));
    else if (event.key === "ArrowUp") focusRow(Math.max(0, activeIndex - 1));
    else if (event.key === "Home") focusRow(0);
    else if (event.key === "End") focusRow(rows.length - 1);
    else if (event.key === "ArrowRight") {
      if (activeRow.kind === "directory") {
        if (!expanded.has(activeRow.path)) toggle(activeRow);
        else if (rows[activeIndex + 1]?.depth > activeRow.depth) focusRow(activeIndex + 1);
      }
    } else if (event.key === "ArrowLeft") {
      if (activeRow.kind === "directory" && expanded.has(activeRow.path)) toggle(activeRow);
      else {
        const separator = activeRow.path.lastIndexOf("/");
        if (separator >= 0) {
          const parent = activeRow.path.slice(0, separator);
          focusRow(rows.findIndex((row) => row.path === parent));
        }
      }
    } else if (event.key === "Enter" || event.key === " ") toggle(activeRow);
    else if (event.key.length === 1) {
      const previous = typeahead.current;
      const key = event.key.toLocaleLowerCase();
      const prefix = performance.now() - previous.at < 700 ? previous.value : "";
      const value = prefix === key ? key : prefix + key;
      typeahead.current = { value, at: performance.now() };
      const start = value.length > 1 ? activeIndex : activeIndex + 1;
      for (let offset = 0; offset < rows.length; offset++) {
        const index = (start + offset + rows.length) % rows.length;
        if (rows[index].name.toLocaleLowerCase().startsWith(value)) {
          focusRow(index);
          break;
        }
      }
    } else return;
    event.preventDefault();
  }
  const visibleRows = rows.slice(virtual.start, virtual.end);
  useEffect(() => {
    if (!active || surface !== "files" || navigation.view !== "files") return;
    rows
      .slice(virtual.start, virtual.end)
      .filter((row) => row.kind === "directory")
      .slice(0, 8)
      .forEach((row) => void repository.preload(row.path));
  }, [active, surface, navigation.view, rows, virtual.start, virtual.end, repository.preload]);
  const focusedMounted = activeRow && visibleRows.includes(activeRow);
  const limitedFolders = [...repository.directories].filter(
    ([path, directory]) => directory.limited && (!path || expanded.has(path)),
  );
  const comparison = repository.changes?.repository
    ? repository.changes.head
      ? "Working tree vs HEAD"
      : "Working tree · no commits yet"
    : "Local files";
  const viewControl = (
    <div className="repository-view-options" role="group" aria-label="Repository view">
      {(["files", "changes"] as const).map((view) => (
        <Button
          key={view}
          className="quiet-button"
          data-view={view}
          aria-pressed={navigation.view === view}
          onClick={() => {
            setNavigation((current) => ({ ...current, view }));
            setFocused(null);
          }}
        >
          {view === "files" ? "All files" : "Changes"}
          {view === "changes" && repository.changes && (
            <span className="repository-view-count">{changedFiles.length}</span>
          )}
        </Button>
      ))}
    </div>
  );
  const treePane = (
    <div className="repository-tree-pane">
      <div
        ref={virtual.attach}
        className="repository-tree"
        onScroll={(event) => {
          if (active && surface === "files" && event.currentTarget.clientHeight > 0) {
            if (treeRestoration.current) treeRestoration.current.pending = false;
            rememberScroll(
              scrollPositions,
              `tree:${navigation.view}`,
              event.currentTarget.scrollTop,
            );
          }
        }}
        role="tree"
        aria-label={navigation.view === "changes" ? "Changed files" : "Repository files"}
        tabIndex={0}
        onKeyDown={keyDown}
        aria-activedescendant={focusedMounted ? `repository-row-${activeIndex}` : undefined}
      >
        <div
          role="none"
          style={{
            height: rows.length * 28,
            position: "relative",
            minWidth: "100%",
          }}
        >
          {visibleRows.map((row, offset) => {
            const status = statuses.get(row.path);
            const isExpanded = row.kind === "directory" ? expanded.has(row.path) : undefined;
            return (
              <Button
                key={row.path}
                id={`repository-row-${virtual.start + offset}`}
                role="treeitem"
                tabIndex={-1}
                aria-level={row.depth}
                aria-posinset={row.position}
                aria-setsize={row.siblings}
                aria-expanded={isExpanded}
                aria-selected={navigation.selected === row.path}
                aria-label={`${row.name}${status ? `, ${status.filtered ? "external filter, comparison unavailable" : status.status}` : ""}${folderChanges.has(row.path) ? `, ${folderChanges.get(row.path)} files to review` : ""}`}
                className={`repository-tree-row ${activeRow?.path === row.path ? "focused" : ""}`}
                data-status={status?.filtered ? undefined : status?.status}
                style={{
                  top: (virtual.start + offset) * 28,
                  paddingLeft: Math.min(row.depth - 1, 12) * 12 + 6,
                }}
                title={
                  status?.filtered
                    ? `${row.path} · External filter: comparison unavailable`
                    : status?.previousPath
                      ? `${status.previousPath} → ${row.path}`
                      : row.path
                }
                onPointerEnter={() => {
                  if (row.kind === "directory") void repository.preload(row.path);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  virtual.ref.current?.focus();
                  setFocused(row.path);
                  toggle(row);
                }}
              >
                {Array.from({ length: Math.min(row.depth - 1, 12) }, (_, index) => (
                  <span
                    className="repository-indent-guide"
                    style={{ left: index * 12 + 12 }}
                    key={index}
                    aria-hidden="true"
                  />
                ))}
                <span className="repository-chevron" data-expanded={isExpanded} aria-hidden="true">
                  {row.kind === "directory" && <RepositoryIcon name="chevron" />}
                </span>
                {row.kind === "directory" ? (
                  <RepositoryIcon
                    name={isExpanded ? "folderOpen" : "folder"}
                    className="repository-entry-icon"
                  />
                ) : (
                  <FileIcon name={row.name} />
                )}
                <span className="repository-entry-name">
                  {row.path.split("/").at(-1) ?? row.name}
                </span>
                {navigation.view === "changes" && row.path.includes("/") && (
                  <span className="repository-entry-parent">
                    {row.path.slice(0, row.path.lastIndexOf("/"))}
                  </span>
                )}
                {row.kind === "directory" && folderChanges.has(row.path) && (
                  <span className="repository-folder-count" aria-hidden="true">
                    {folderChanges.get(row.path)}
                  </span>
                )}
                {status && (
                  <span
                    className="repository-file-status"
                    data-status={status.filtered ? undefined : status.status}
                    aria-hidden="true"
                  >
                    {status.filtered
                      ? "F"
                      : status.status === "untracked"
                        ? "U"
                        : status.status[0].toUpperCase()}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
        {!rows.length && (
          <p className="repository-empty" role="status">
            {!repository.directories.has("") && navigation.view === "files"
              ? "Reading files…"
              : navigation.view === "changes"
                ? repository.changes
                  ? repository.changes.limited
                    ? "Some files could not be checked"
                    : "No changed files"
                  : repository.error
                    ? "Changes unavailable"
                    : "Reading changes…"
                : "This folder is empty"}
          </p>
        )}
      </div>
      {limitedFolders.length > 0 && (
        <p className="repository-limit">
          Folder preview limit reached (5,000 entries or 2 MiB). Some files are omitted.
        </p>
      )}
      {navigation.view === "files" &&
        [...repository.directories].some(
          ([path, directory]) => directory.ignoreUnavailable && (!path || expanded.has(path)),
        ) && (
          <p className="repository-limit" role="status">
            Some ignored files may be shown.
          </p>
        )}
      {navigation.view === "changes" && repository.changes?.limited && (
        <p className="repository-limit" role="status">
          Some filtered files could not be checked. Ordinary changes are shown.
        </p>
      )}
    </div>
  );
  return (
    <div className="repository-browser">
      {(repository.error || treeError) && (
        <div className="repository-notice" role="alert">
          <span>{treeError || repository.error}</span>
          <Button
            className="quiet-button"
            onClick={() => {
              setTreeError("");
              void repository.refresh();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="repository-panes">
        <div
          id="workspace-surface-files"
          role="tabpanel"
          aria-labelledby="workspace-tab-files"
          className="repository-navigation"
          hidden={surface !== "files"}
        >
          <div className="repository-navigation-header">
            {viewControl}
            <div className="repository-navigation-actions">
              {navigation.view === "files" && expanded.size > 0 && (
                <Button
                  className="quiet-button repository-icon-button"
                  aria-label="Collapse all folders"
                  title="Collapse all folders"
                  onClick={() => {
                    setNavigation((current) => ({ ...current, expanded: [] }));
                    setFocused(null);
                  }}
                >
                  <RepositoryIcon name="collapse" />
                </Button>
              )}
              <Button
                className="quiet-button repository-icon-button"
                onClick={() => void repository.refresh()}
                aria-label="Refresh repository"
                title="Refresh repository"
                aria-busy={repository.refreshing}
              >
                <RepositoryIcon name="refresh" />
              </Button>
            </div>
          </div>
          {treePane}
        </div>
        <div
          id="workspace-surface-diff"
          role="tabpanel"
          aria-labelledby="workspace-tab-diff"
          className="repository-file-pane"
          hidden={surface !== "diff"}
        >
          <div className="repository-file-heading">
            <div className="repository-file-path" title={navigation.selected ?? undefined}>
              {navigation.selected && <FileIcon name={navigation.selected} />}
              <span className="repository-file-identity">
                {navigation.selected?.includes("/") && (
                  <span className="repository-file-parent">
                    {navigation.selected.slice(0, navigation.selected.lastIndexOf("/") + 1)}
                  </span>
                )}
                <span className="repository-file-name">
                  {navigation.selected?.split("/").at(-1) ?? "Select a file"}
                </span>
              </span>
            </div>
            {selectedChange && (
              <span
                className="repository-status-label"
                data-status={selectedChange.filtered ? undefined : selectedChange.status}
              >
                {selectedChange.filtered
                  ? "External filter"
                  : selectedChange.status === "typechange"
                    ? "Type changed"
                    : selectedChange.status}
              </span>
            )}
            {changedIndex >= 0 && changedFiles.length > 1 && (
              <div className="repository-file-navigation" aria-label="Changed file navigation">
                <span>
                  {changedIndex + 1} / {changedFiles.length}
                </span>
                {([-1, 1] as const).map((direction) => (
                  <Button
                    key={direction}
                    className="quiet-button repository-icon-button"
                    aria-label={direction === -1 ? "Previous changed file" : "Next changed file"}
                    title={direction === -1 ? "Previous changed file" : "Next changed file"}
                    disabled={
                      changedIndex + direction < 0 ||
                      changedIndex + direction >= changedFiles.length
                    }
                    onClick={() => {
                      const next = changedFiles[changedIndex + direction];
                      if (next) {
                        setFocused(next.path);
                        setNavigation((current) => ({ ...current, selected: next.path }));
                      }
                    }}
                  >
                    <RepositoryIcon name={direction === -1 ? "previous" : "next"} />
                  </Button>
                ))}
              </div>
            )}
            <Button
              className="quiet-button repository-icon-button"
              onClick={() => void repository.refresh()}
              aria-label="Refresh repository"
              title={comparison}
              aria-busy={repository.refreshing}
            >
              <RepositoryIcon name="refresh" />
            </Button>
            {navigation.selected && statuses.get(navigation.selected)?.previousPath && (
              <small title={statuses.get(navigation.selected)?.previousPath ?? undefined}>
                Renamed from {statuses.get(navigation.selected)?.previousPath}
              </small>
            )}
          </div>
          {navigation.selected && repository.file?.path !== navigation.selected && (
            <p className="repository-loading" role="status">
              Loading {navigation.selected}…
              {repository.file ? ` Showing ${repository.file.path} while it loads.` : ""}
            </p>
          )}
          {repository.file ? (
            <FileContent
              file={repository.file.content}
              path={repository.file.path}
              active={active && surface === "diff"}
              visible={surface === "diff"}
              positions={scrollPositions}
            />
          ) : (
            <p className="repository-empty">
              {navigation.selected ? (
                ""
              ) : (
                <Button className="quiet-button" onClick={() => onOpenSurface("files")}>
                  Choose a file
                </Button>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
