import { FilePrefetchContext } from "./file-prefetch";
import { fileOpenError } from "./file-open-error";
import { repositoryRead } from "./repository-read";
import type { FileNavigationRequest, FileLineTarget } from "./file-navigation";
import { parseChatLink } from "../../../../shared/models/chat-links";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { z } from "zod";
import { Button } from "@tidy/ui/button";
import { useSessionState } from "../../app/session-state";
import { visibleTreeRows, type TreeRow } from "./file-rows";
import { useVirtualWindow } from "./virtual-window";
import { useRepositoryFiles, type RepositoryAPI } from "./use-repository-files";
import { useRepositorySearch } from "./use-repository-search";
import { useRepositoryScroll, rememberScroll } from "./use-repository-scroll";
import { ContinuousReview } from "./continuous-review";
import { FileContent } from "./repository-file-preview";
import { RepositoryExplorer } from "./repository-explorer";
import {
  changedFileDirectories,
  changeFolderSchema,
  changeFolderExceptionLimit,
  expandedChangeFolders,
  toggleChangeFolder,
} from "./repository-navigation";
import { FileIcon, RepositoryIcon } from "./repository-icons";
import "./repository-browser.css";

const navigationSchema = z.object({
  selected: z.string().nullable(),
  expanded: z.array(z.string()).max(64),
});
export function RepositoryBrowser({
  api,
  projectId,
  active,
  surface,
  fileRequest,
  connected = true,
}: {
  api: RepositoryAPI;
  projectId: string;
  active: boolean;
  surface: "files" | "diff";
  fileRequest?: FileNavigationRequest;
  connected?: boolean;
}) {
  const prefetch = useContext(FilePrefetchContext);
  const [navigation, setNavigation] = useSessionState(`repository:${projectId}`, navigationSchema, {
    selected: null,
    expanded: [],
  });
  const [lineTarget, setLineTarget] = useState<FileLineTarget>();
  const [linkState, setLinkState] = useState<
    { kind: "pending" } | { kind: "error"; message: string; retry: boolean }
  >();
  const [linkAttempt, setLinkAttempt] = useState(0);
  const linkGeneration = useRef(0);
  useLayoutEffect(() => {
    if (!fileRequest) return;
    const generation = ++linkGeneration.current;
    setLinkState({ kind: "pending" });
    setLineTarget(undefined);
    const link = parseChatLink(fileRequest.href);
    const resolve = prefetch
      ? prefetch.resolve(fileRequest.href)
      : api.resolveRepositoryLink
        ? repositoryRead(api.resolveRepositoryLink(projectId, fileRequest.href))
        : Promise.reject(
            new Error(
              "Reconnect or update the machine running this thread to preview file references.",
            ),
          );
    void resolve.then(
      (path) => {
        if (linkGeneration.current !== generation) return;
        setQuery("");
        setNavigation((current) => {
          const parents = path
            .split("/")
            .slice(0, -1)
            .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
          return {
            selected: path,
            expanded: [...new Set([...parents, ...current.expanded])].slice(0, 64),
          };
        });
        setFocused(path);
        setLineTarget({
          id: fileRequest.id,
          path,
          line: link?.kind === "file" ? (link.line ?? 1) : 1,
          ...(link?.kind === "file" && link.column ? { column: link.column } : {}),
          ...(link?.kind === "file" && link.endLine ? { endLine: link.endLine } : {}),
        });
        setLinkState(undefined);
      },
      (cause: unknown) => {
        if (linkGeneration.current === generation)
          setLinkState({
            kind: "error",
            ...fileOpenError(cause),
          });
      },
    );
    return () => {
      if (linkGeneration.current === generation) linkGeneration.current++;
    };
  }, [fileRequest?.id, api, projectId, linkAttempt, prefetch]);
  function cancelLinkNavigation() {
    linkGeneration.current++;
    setLinkState(undefined);
    setLineTarget(undefined);
  }
  const view = surface === "diff" ? "changes" : "files";
  const [selectedChange, setSelectedChange] = useSessionState(
    `repository-change:${projectId}`,
    z.string().nullable(),
    null,
  );
  const [collapsedChanges, setCollapsedChanges] = useSessionState(
    `repository-change-folders:${projectId}`,
    changeFolderSchema,
    { collapsed: false, exceptions: [] },
  );
  const [reviewMounted, setReviewMounted] = useState(surface === "diff");
  useEffect(() => {
    if (surface === "diff") setReviewMounted(true);
  }, [surface]);
  const [query, setQuery] = useState("");
  const fileAPI = useMemo<RepositoryAPI>(
    () => ({
      ...api,
      repositoryFile: (id, path, previousPath) =>
        prefetch
          ? prefetch.read(path, previousPath)
          : api.repositoryFile(id, path, previousPath, "file"),
    }),
    [api, prefetch],
  );
  const scrollPositions = useRepositoryScroll(projectId);
  const fileExpanded = useMemo(() => new Set(navigation.expanded), [navigation.expanded]);
  const repository = useRepositoryFiles({
    api: fileAPI,
    projectId,
    active,
    selected: surface === "files" ? navigation.selected : null,
    expanded: fileExpanded,
    prefetch,
    requestId: lineTarget?.id,
  });
  const search = useRepositorySearch(
    api,
    projectId,
    query,
    active && view === "files",
    repository.contentRevision.id,
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const [treeError, setTreeError] = useState("");
  useEffect(() => setTreeError(""), [view]);
  const changeDirectories = useMemo(
    () => changedFileDirectories(repository.changes?.changes ?? []),
    [repository.changes],
  );
  const expanded = useMemo(
    () =>
      view === "files"
        ? fileExpanded
        : expandedChangeFolders(changeDirectories.keys(), collapsedChanges),
    [view, fileExpanded, changeDirectories, collapsedChanges],
  );
  const selected = view === "files" ? navigation.selected : selectedChange;
  const rows = useMemo<TreeRow[]>(() => {
    const directories = view === "files" ? repository.directories : changeDirectories;
    if (view === "changes" || !query.trim()) return visibleTreeRows(directories, expanded);
    const entries = search.entries;
    return entries.map((entry, index) => ({
      ...entry,
      depth: 1,
      position: index + 1,
      siblings: entries.length,
    }));
  }, [view, repository.directories, changeDirectories, expanded, query, search.entries]);
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
  const virtual = useVirtualWindow(rows.length, 28);
  const activeRow =
    rows.find((row) => row.path === focused) ??
    rows.find((row) => row.path === selected) ??
    rows[0];
  const activeIndex = activeRow ? rows.indexOf(activeRow) : -1;
  const revealedTreeTarget = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      !active ||
      surface !== "files" ||
      !lineTarget ||
      navigation.selected !== lineTarget.path ||
      revealedTreeTarget.current === lineTarget.id
    )
      return;
    const index = rows.findIndex((row) => row.path === lineTarget.path);
    if (index < 0) return;
    virtual.reveal(index);
    revealedTreeTarget.current = lineTarget.id;
  }, [active, surface, rows, lineTarget, navigation.selected]);

  const treeRestoration = useRef<{ view: string; top: number; pending: boolean } | null>(null);
  useLayoutEffect(() => {
    const node = virtual.ref.current;
    if (!active || !node) {
      treeRestoration.current = null;
      return;
    }
    if (treeRestoration.current?.view !== view)
      treeRestoration.current = {
        view: view,
        top: scrollPositions.get(`tree:${view}`) ?? 0,
        pending: true,
      };
    const restoration = treeRestoration.current;
    if (!restoration.pending) return;
    const loaded =
      view === "changes"
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
    view,
    surface,
    active,
    rows,
    expanded,
    repository.directories,
    repository.changes,
    scrollPositions,
  ]);
  const panes = useRef<HTMLDivElement>(null);
  const restoreTreeFocus = useRef(false);
  useLayoutEffect(() => {
    if (!navigation.selected && restoreTreeFocus.current) {
      restoreTreeFocus.current = false;
      virtual.ref.current?.focus();
    }
    const node = panes.current;
    const focused = document.activeElement;
    if (!node || surface !== "files" || !(focused instanceof HTMLElement)) return;
    if (
      navigation.selected &&
      node.clientWidth <= 420 &&
      node.querySelector(".repository-explorer")?.contains(focused)
    )
      node.querySelector<HTMLButtonElement>(".repository-file-pane:not([hidden]) button")?.focus();
    else if (
      !navigation.selected &&
      node.querySelector(".repository-file-pane[hidden]")?.contains(focused)
    )
      virtual.ref.current?.focus();
  }, [navigation.selected, surface]);
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
      cancelLinkNavigation();
      setReveal((value) => value + 1);
      if (view === "changes") setSelectedChange(row.path);
      else setNavigation((current) => ({ ...current, selected: row.path }));
      return;
    }
    if (view === "changes") {
      const next = toggleChangeFolder(collapsedChanges, row.path);
      if (next === collapsedChanges)
        setTreeError(
          `Use Collapse all before changing more than ${changeFolderExceptionLimit} folders.`,
        );
      else setCollapsedChanges(next);
      return;
    }
    if (!expanded.has(row.path) && expanded.size >= 64) {
      setTreeError("Collapse a folder before expanding more than 64 folders.");
      return;
    }
    setNavigation((current) => ({
      ...current,
      expanded: expanded.has(row.path)
        ? current.expanded.filter((path) => path !== row.path && !path.startsWith(`${row.path}/`))
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
    if (!active || view !== "files") return;
    rows
      .slice(virtual.start, virtual.end)
      .filter((row) => row.kind === "directory")
      .slice(0, 8)
      .forEach((row) => void repository.preload(row.path));
  }, [active, surface, view, rows, virtual.start, virtual.end, repository.preload]);
  const focusedMounted = activeRow && visibleRows.includes(activeRow);
  const limitedFolders = [...repository.directories].filter(
    ([path, directory]) => directory.limited && (!path || expanded.has(path)),
  );
  const comparison = repository.changes?.repository
    ? repository.changes.head
      ? "Working tree vs HEAD"
      : "Working tree · no commits yet"
    : "Local files";
  const treePane = (
    <div className="repository-tree-pane">
      <div
        ref={virtual.attach}
        className="repository-tree"
        onScroll={(event) => {
          if (active && event.currentTarget.clientHeight > 0) {
            if (treeRestoration.current) treeRestoration.current.pending = false;
            rememberScroll(scrollPositions, `tree:${view}`, event.currentTarget.scrollTop);
          }
        }}
        role="tree"
        aria-label={view === "changes" ? "Changed files" : "Repository files"}
        tabIndex={0}
        onKeyDown={keyDown}
        onFocus={(event) => {
          if (event.target === event.currentTarget && event.currentTarget.matches(":focus-visible"))
            focusRow(activeIndex);
        }}
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
                aria-selected={selected === row.path}
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
                <span className="repository-entry-name">{row.name}</span>
                {view === "files" && query.trim() && row.path.includes("/") && (
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
            {view === "files" && query.trim()
              ? search.pending
                ? "Searching files…"
                : search.error
                  ? "Search unavailable"
                  : "No matching files"
              : !repository.directories.has("") && view === "files"
                ? repository.directoryError
                  ? "Files unavailable"
                  : "Reading files…"
                : view === "changes"
                  ? repository.changes
                    ? repository.changes.limited
                      ? "Some files could not be checked"
                      : "No changed files"
                    : repository.changesError
                      ? "Changes unavailable"
                      : "Reading changes…"
                  : "This folder is empty"}
          </p>
        )}
      </div>
      {view === "files" && query.trim() && search.limited && (
        <p className="repository-limit" role="status">
          Search limit reached. Refine your search to find more files.
        </p>
      )}
      {limitedFolders.length > 0 && (
        <p className="repository-limit">
          Folder preview limit reached (5,000 entries or 2 MiB). Some files are omitted.
        </p>
      )}
      {view === "files" &&
        [...repository.directories].some(
          ([path, directory]) => directory.ignoreUnavailable && (!path || expanded.has(path)),
        ) && (
          <p className="repository-limit" role="status">
            Some ignored files may be shown.
          </p>
        )}
      {view === "changes" && repository.changes?.limited && (
        <p className="repository-limit" role="status">
          Some filtered files could not be checked. Ordinary changes are shown.
        </p>
      )}
    </div>
  );
  function errorNotice(failure: { message: string; retry: boolean }) {
    return failure.message ? (
      <div className="repository-notice" role="alert">
        <span>{failure.message}</span>
        {failure.retry && (
          <Button
            className="quiet-button"
            onClick={() => {
              setTreeError("");
              void repository.refresh();
            }}
          >
            Retry
          </Button>
        )}
      </div>
    ) : null;
  }
  return (
    <div className="repository-browser">
      <div
        ref={panes}
        className="repository-panes @max-[420px]/repository-surface:[&[data-file-preview=true]>.repository-explorer]:hidden"
        data-file-preview={surface === "files" && Boolean(navigation.selected || linkState)}
        data-preview={surface === "diff" || Boolean(navigation.selected || linkState) || undefined}
        id={surface === "files" ? "workspace-surface-files" : undefined}
        role={surface === "files" ? "tabpanel" : undefined}
        aria-labelledby={surface === "files" ? "workspace-tab-files" : undefined}
      >
        <div className="repository-file-pane" hidden={surface !== "diff"}>
          {(reviewMounted || surface === "diff") && (
            <div
              id="workspace-surface-diff"
              role="tabpanel"
              aria-labelledby="workspace-tab-diff"
              className="repository-review flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              {repository.changesError && errorNotice(fileOpenError(repository.changesError))}
              <ContinuousReview
                api={api}
                projectId={projectId}
                changes={changedFiles}
                selected={selectedChange}
                reveal={reveal}
                active={active && surface === "diff"}
                revision={repository.contentRevision}
                comparison={comparison}
                refreshing={repository.refreshing}
                loading={!repository.changes && !repository.changesError}
                error={repository.changesError}
                onRefresh={() => void repository.refresh()}
                onSelect={(path) => {
                  setFocused(path);
                  setSelectedChange(path);
                }}
              />
            </div>
          )}
        </div>
        <div
          className="repository-file-pane"
          hidden={surface !== "files" || (!navigation.selected && !linkState)}
        >
          <div className="repository-file-heading">
            <div
              className="repository-file-path"
              title={linkState ? fileRequest?.href : (navigation.selected ?? undefined)}
            >
              <FileIcon name={navigation.selected ?? ""} />
              <span className="repository-file-identity">
                <span className="repository-file-name">
                  {linkState ? fileRequest?.href : navigation.selected}
                </span>
              </span>
            </div>
            <Button
              className="quiet-button repository-icon-button"
              aria-label="Close file preview"
              title="Close file preview"
              onClick={() => {
                cancelLinkNavigation();
                restoreTreeFocus.current = true;
                setNavigation((current) => ({ ...current, selected: null }));
              }}
            >
              <RepositoryIcon name="close" />
            </Button>
          </div>
          {!connected && repository.file && (
            <p className="px-3 py-2 text-xs text-muted-ink" role="status">
              This machine is offline. Showing the last loaded file.
            </p>
          )}
          {linkState && (
            <div
              className="flex items-center gap-3 px-3 py-2 text-xs text-muted-ink"
              role={linkState.kind === "error" ? "alert" : "status"}
            >
              <span>
                {linkState.kind === "pending" ? "Opening file…" : linkState.message}
                {repository.file ? ` Showing ${repository.file.path}.` : ""}
              </span>
              {linkState.kind === "error" && linkState.retry && (
                <Button
                  className="quiet-button"
                  onClick={() => setLinkAttempt((value) => value + 1)}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
          {!linkState && repository.fileError && errorNotice(fileOpenError(repository.fileError))}
          {navigation.selected && repository.file?.path !== navigation.selected && (
            <p className="repository-loading" role="status">
              {repository.fileError ? "File unavailable" : `Loading ${navigation.selected}…`}
              {repository.file ? ` Showing ${repository.file.path}.` : ""}
            </p>
          )}
          {repository.file && (
            <FileContent
              file={repository.file.content}
              path={repository.file.path}
              active={active && surface === "files"}
              visible={surface === "files"}
              positions={scrollPositions}
              onRetry={() => void repository.refresh()}
              target={
                !linkState && lineTarget?.path === navigation.selected ? lineTarget : undefined
              }
            />
          )}
        </div>
        <RepositoryExplorer
          key={`${projectId}:${view}`}
          projectId={projectId}
          view={view}
          resizable={surface === "diff" || Boolean(navigation.selected || linkState)}
        >
          <div
            role="region"
            aria-label={view === "changes" ? "Changed files navigation" : "File navigation"}
            className="repository-navigation"
          >
            <div className="repository-navigation-header">
              <Button
                className="quiet-button repository-icon-button"
                onClick={() => void repository.refresh()}
                aria-label="Refresh repository"
                title="Refresh repository"
                aria-busy={repository.refreshing}
              >
                <RepositoryIcon name="refresh" />
              </Button>
              {view === "files" ? (
                <input
                  type="search"
                  className="repository-search w-full min-w-0 flex-1 border-0 bg-transparent px-0 py-[3px] text-[12px] text-ink outline-none focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-(--color-control-border)"
                  aria-label="Search files"
                  placeholder="Search files"
                  maxLength={256}
                  value={query}
                  onChange={(event) => {
                    cancelLinkNavigation();
                    setQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
              ) : (
                <span
                  className="repository-explorer-label flex min-w-0 flex-1 gap-1 text-[12px] whitespace-nowrap text-ink"
                  title={`${changedFiles.length} changed files`}
                >
                  <span className="truncate">Changed files</span>
                  <span className="shrink-0 text-muted-ink tabular-nums">
                    {changedFiles.length}
                  </span>
                </span>
              )}
              {expanded.size > 0 && (
                <Button
                  className="quiet-button repository-icon-button"
                  aria-label="Collapse all folders"
                  title="Collapse all folders"
                  onClick={() => {
                    if (view === "changes")
                      setCollapsedChanges({ collapsed: true, exceptions: [] });
                    else setNavigation((current) => ({ ...current, expanded: [] }));
                    setFocused(null);
                  }}
                >
                  <RepositoryIcon name="collapse" />
                </Button>
              )}
            </div>
            {errorNotice({
              message:
                treeError || (view === "files" ? search.error || repository.directoryError : ""),
              retry: true,
            })}
            {treePane}
          </div>
        </RepositoryExplorer>
      </div>
    </div>
  );
}
