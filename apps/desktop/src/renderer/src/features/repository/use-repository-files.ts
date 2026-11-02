import { useCallback, useEffect, useRef, useState } from "react";
import { repositoryRead } from "./repository-read";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type {
  RepositoryChanges,
  RepositoryDirectory,
  RepositoryFile,
} from "../../../../shared/contracts/repository-files";

export type RepositoryAPI = Required<
  Pick<DesktopAPI, "repositoryDirectory" | "repositoryChanges" | "repositoryFile">
> &
  Pick<DesktopAPI, "onEvent" | "repositorySearch">;

export type RepositoryInvalidation = { id: number; paths: readonly string[] | null };

export function useRepositoryFiles({
  api,
  projectId,
  active,
  selected,
  expanded,
  continuous = false,
}: {
  api: RepositoryAPI;
  projectId: string;
  active: boolean;
  selected: string | null;
  expanded: ReadonlySet<string>;
  continuous?: boolean;
}) {
  const [directories, setDirectories] = useState(new Map<string, RepositoryDirectory>());
  const [changes, setChanges] = useState<RepositoryChanges>();
  const [file, setFile] = useState<{ path: string; content: RepositoryFile }>();
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [changesError, setChangesError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [contentRevision, setContentRevision] = useState<RepositoryInvalidation>({
    id: 0,
    paths: null,
  });
  const directoryQueue = useRef(new Set<string>());
  const directoryRequests = useRef(new Map<string, Promise<void>>());
  const directoryCache = useRef(new Map<string, RepositoryDirectory>());
  const directoryFailures = useRef(new Map<string, string>());
  const fileGeneration = useRef(new Map<string, number>());
  const fileCache = useRef(new Map<string, RepositoryFile>());
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const latest = useRef({ selected, expanded, active });
  latest.current = { selected, expanded, active };
  const lifetime = useRef(true);
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
    };
  }, []);

  function rememberDirectoryFailure(path: string, message: string) {
    const failures = directoryFailures.current;
    failures.set(path, message);
    if (failures.size > 128) {
      const first = failures.keys().next().value;
      if (first !== undefined) failures.delete(first);
    }
    setError(message);
  }

  function clearDirectoryFailure(path: string) {
    if (directoryFailures.current.delete(path))
      setError([...directoryFailures.current.values()].at(-1) ?? "");
  }

  const loadDirectory = useCallback(
    (path: string, force = false): Promise<void> => {
      if (!lifetime.current || !latest.current.active) return Promise.resolve();
      const pending = directoryRequests.current.get(path);
      if (pending) return force ? pending.then(() => loadDirectory(path, true)) : pending;
      if (!force && directoryCache.current.has(path)) return Promise.resolve();
      if (!force && directoryFailures.current.has(path)) return Promise.resolve();
      if (directoryRequests.current.size >= 4) {
        if (force)
          return Promise.race(directoryRequests.current.values()).then(() =>
            loadDirectory(path, true),
          );
        directoryQueue.current.add(path);
        if (directoryQueue.current.size > 128) {
          const oldest = directoryQueue.current.values().next().value;
          if (oldest !== undefined) directoryQueue.current.delete(oldest);
        }
        return Promise.resolve();
      }
      directoryQueue.current.delete(path);
      const request = repositoryRead(api.repositoryDirectory(projectId, path))
        .then((value) => {
          if (!lifetime.current) return;
          const cache = directoryCache.current;
          const previous = cache.get(path);
          if (
            previous &&
            previous.limited === value.limited &&
            previous.ignoreUnavailable === value.ignoreUnavailable &&
            previous.entries.length === value.entries.length &&
            previous.entries.every(
              (entry, index) =>
                entry.path === value.entries[index].path &&
                entry.kind === value.entries[index].kind,
            )
          ) {
            clearDirectoryFailure(path);
            return;
          }
          if (previous) {
            const retained = new Set(
              value.entries
                .filter((entry) => entry.kind === "directory")
                .map((entry) => entry.path),
            );
            for (const entry of previous.entries) {
              if (entry.kind !== "directory" || retained.has(entry.path)) continue;
              for (const key of cache.keys())
                if (key === entry.path || key.startsWith(`${entry.path}/`)) cache.delete(key);
            }
          }
          cache.delete(path);
          cache.set(path, value);
          let size = [...cache.values()].reduce(
            (total, directory) => total + directory.entries.length,
            0,
          );
          for (const [key, directory] of cache) {
            if (cache.size <= 128 && size <= 30000) break;
            if (key === "" || key === path || latest.current.expanded.has(key)) continue;
            cache.delete(key);
            size -= directory.entries.length;
          }
          if (size > 30000 || cache.size > 128) {
            cache.delete(path);
            if (previous) cache.set(path, previous);
            rememberDirectoryFailure(
              path,
              "The folder cache is full. Collapse some folders, then refresh to continue browsing.",
            );
            return;
          }
          clearDirectoryFailure(path);
          setDirectories(new Map(cache));
        })
        .catch((cause: unknown) => {
          if (lifetime.current)
            rememberDirectoryFailure(
              path,
              cause instanceof Error ? cause.message : "Could not read this folder.",
            );
        })
        .finally(() => {
          directoryRequests.current.delete(path);
          const next = [...latest.current.expanded, ...directoryQueue.current].find(
            (candidate) =>
              !directoryCache.current.has(candidate) &&
              !directoryRequests.current.has(candidate) &&
              !directoryFailures.current.has(candidate) &&
              knownDirectory(candidate),
          );
          if (next !== undefined) void loadDirectory(next);
        });
      directoryRequests.current.set(path, request);
      return request;
    },
    [api, projectId],
  );

  function knownDirectory(path: string) {
    if (!path) return true;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return directoryCache.current
      .get(parent)
      ?.entries.some((entry) => entry.path === path && entry.kind === "directory");
  }
  const refreshingRef = useRef(false);
  const fileRunning = useRef(new Map<symbol, string>());
  const latestFileRequest = useRef(new Map<string, symbol>());
  const changesInitialized = useRef(false);
  const lastReconciliation = useRef(Date.now());
  const pendingRefresh = useRef<{ full: boolean; paths: Set<string>; reconcile: boolean } | null>(
    null,
  );
  const refresh = useCallback(
    async function refresh(paths?: string[], reconcile = false) {
      if (!latest.current.active) return;
      if (refreshingRef.current) {
        const pending = pendingRefresh.current ?? {
          full: false,
          paths: new Set<string>(),
          reconcile,
        };
        pending.reconcile &&= reconcile;
        if (!paths) pending.full = true;
        else paths.forEach((path) => pending.paths.add(path));
        pendingRefresh.current = pending;
        return;
      }
      refreshingRef.current = true;
      const initialized = changesInitialized.current;
      const lightweight = reconcile && Date.now() - lastReconciliation.current < 60000;
      if (!lightweight) lastReconciliation.current = Date.now();
      let invalidateAll = initialized && !paths && !lightweight;
      const invalidated = new Set(initialized ? paths : []);
      const touches = (path: string) =>
        invalidateAll ||
        [...invalidated].some(
          (parent) => !parent || path === parent || path.startsWith(`${parent}/`),
        );
      changesInitialized.current = true;
      setRefreshing(true);
      const targets = (paths ?? (lightweight ? [] : ["", ...latest.current.expanded])).filter(
        knownDirectory,
      );
      const refreshDirectories = async () => {
        for (let index = 0; index < targets.length; index += 4) {
          if (!lifetime.current || !latest.current.active) break;
          await Promise.all(
            targets.slice(index, index + 4).map((path) => loadDirectory(path, true)),
          );
        }
      };
      const directoriesReady = refreshDirectories();
      try {
        await repositoryRead(api.repositoryChanges(projectId)).then(
          (result) => {
            if (!lifetime.current) return;
            const previous = changesRef.current;
            if (
              initialized &&
              previous &&
              (previous.head !== result.head || previous.repository !== result.repository)
            )
              invalidateAll = true;
            const before = new Map(previous?.changes.map((change) => [change.path, change]));
            const after = new Map(result.changes.map((change) => [change.path, change]));
            if (lightweight) {
              const parents = new Set<string>();
              for (const path of new Set([...before.keys(), ...after.keys()])) {
                const old = before.get(path);
                const next = after.get(path);
                if (
                  old?.status !== next?.status ||
                  old?.previousPath !== next?.previousPath ||
                  old?.filtered !== next?.filtered
                ) {
                  invalidated.add(path);
                  parents.add(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
                }
              }
              for (const parent of parents)
                if (directoryCache.current.has(parent)) void loadDirectory(parent, true);
            }
            for (const path of new Set([
              ...fileCache.current.keys(),
              ...(latest.current.selected ? [latest.current.selected] : []),
              ...fileRunning.current.values(),
            ]))
              if (
                (before.get(path)?.previousPath ?? null) !==
                  (after.get(path)?.previousPath ?? null) ||
                before.get(path)?.filtered !== after.get(path)?.filtered
              )
                invalidated.add(path);
            setChanges((previous) =>
              previous?.repository === result.repository &&
              previous.head === result.head &&
              previous.limited === result.limited &&
              previous.changes.length === result.changes.length &&
              previous.changes.every((change, index) => {
                const next = result.changes[index];
                return (
                  change.path === next.path &&
                  change.previousPath === next.previousPath &&
                  change.filtered === next.filtered &&
                  change.status === next.status
                );
              })
                ? previous
                : result,
            );
            setChangesError("");
          },
          (cause: unknown) => {
            if (lifetime.current)
              setChangesError(
                cause instanceof Error && cause.message
                  ? cause.message
                  : "Could not read Git changes.",
              );
          },
        );
        if (!lifetime.current) return;
        for (const path of new Set(fileRunning.current.values()))
          if (touches(path))
            fileGeneration.current.set(path, (fileGeneration.current.get(path) ?? 0) + 1);
        for (const path of fileCache.current.keys())
          if (touches(path)) fileCache.current.delete(path);
        if (latest.current.selected && touches(latest.current.selected))
          setRevision((value) => value + 1);
        if (initialized && (invalidateAll || invalidated.size))
          setContentRevision((value) => ({
            id: value.id + 1,
            paths: invalidateAll ? null : [...invalidated],
          }));
        await directoriesReady;
      } catch (cause) {
        if (lifetime.current)
          setError(cause instanceof Error ? cause.message : "Could not refresh this repository.");
      } finally {
        refreshingRef.current = false;
        if (lifetime.current) setRefreshing(false);
        const pending = pendingRefresh.current;
        pendingRefresh.current = null;
        if (pending && lifetime.current && latest.current.active)
          void refresh(pending.full ? undefined : [...pending.paths], pending.reconcile);
      }
    },
    [api, projectId, loadDirectory],
  );

  useEffect(() => {
    if (!active) return;
    void loadDirectory("");
    void refresh(changesInitialized.current ? undefined : []);
    const focus = () => {
      if (!document.hidden) void refresh();
    };
    const reconcile = () => {
      if (!document.hidden) void refresh(undefined, true);
    };
    const dirty = new Set<string>();
    let notification: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== "repository-change" || event.projectId !== projectId || document.hidden)
        return;
      dirty.add(event.path);
      if (notification) return;
      notification = setTimeout(() => {
        notification = undefined;
        const paths = [...dirty];
        dirty.clear();
        void refresh(paths);
      }, 100);
    });
    window.addEventListener("focus", focus);
    const timer = setInterval(reconcile, 15000);
    return () => {
      unsubscribe();
      clearTimeout(notification);
      window.removeEventListener("focus", focus);
      clearInterval(timer);
    };
  }, [active, refresh, loadDirectory]);

  useEffect(() => {
    if (!active) return;
    const paths = [...expanded].filter((path) => !directories.has(path) && knownDirectory(path));
    paths.slice(0, 4).forEach((path) => void loadDirectory(path));
  }, [active, expanded, directories, loadDirectory]);

  const wantedFile = useRef<{ path: string } | null>(null);
  const requestFile = useCallback(
    async function run() {
      if (fileRunning.current.size >= 4) return;
      const wanted = wantedFile.current;
      if (!wanted || !latest.current.active) return;
      wantedFile.current = null;
      const request = Symbol(wanted.path);
      fileRunning.current.set(request, wanted.path);
      latestFileRequest.current.set(wanted.path, request);
      const generation = fileGeneration.current.get(wanted.path) ?? 0;
      const previousPath =
        changesRef.current?.changes.find((change) => change.path === wanted.path)?.previousPath ??
        undefined;
      try {
        const content = await repositoryRead(
          api.repositoryFile(projectId, wanted.path, previousPath),
        );
        if (
          !lifetime.current ||
          generation !== (fileGeneration.current.get(wanted.path) ?? 0) ||
          latestFileRequest.current.get(wanted.path) !== request
        )
          return;
        if (!wantedFile.current) {
          fileCache.current.delete(wanted.path);
          fileCache.current.set(wanted.path, content);
          let size = 0;
          for (const value of fileCache.current.values())
            size += value.kind === "text" ? value.text.length : 0;
          while (fileCache.current.size > 12 || size > 4 * 1024 * 1024) {
            const first = fileCache.current.keys().next().value;
            if (first === undefined) break;
            const value = fileCache.current.get(first);
            size -= value?.kind === "text" ? value.text.length : 0;
            fileCache.current.delete(first);
          }
          if (latest.current.selected === wanted.path) {
            setFile((previous) => {
              if (
                previous?.path === wanted.path &&
                (previous.content.kind === "text" && content.kind === "text"
                  ? previous.content.text === content.text &&
                    previous.content.view === content.view &&
                    previous.content.comparison === content.comparison &&
                    previous.content.deleted === content.deleted
                  : previous.content.kind === "unavailable" &&
                    content.kind === "unavailable" &&
                    previous.content.reason === content.reason)
              ) {
                fileCache.current.set(wanted.path, previous.content);
                return previous;
              }
              return { path: wanted.path, content };
            });
            setFileError("");
          }
        }
      } catch (cause) {
        if (
          lifetime.current &&
          generation === (fileGeneration.current.get(wanted.path) ?? 0) &&
          latestFileRequest.current.get(wanted.path) === request &&
          latest.current.selected === wanted.path &&
          !wantedFile.current
        )
          setFileError(
            cause instanceof Error && cause.message ? cause.message : "Could not read this file.",
          );
      } finally {
        fileRunning.current.delete(request);
        if (![...fileRunning.current.values()].includes(wanted.path))
          fileGeneration.current.delete(wanted.path);
        if (latestFileRequest.current.get(wanted.path) === request)
          latestFileRequest.current.delete(wanted.path);
        if (lifetime.current && wantedFile.current) void run();
      }
    },
    [api, projectId],
  );

  const deferPreview =
    continuous &&
    ((!changes && !changesError) ||
      Boolean(changes?.changes.some((change) => change.path === selected)));
  useEffect(() => {
    wantedFile.current = null;
    setFileError("");
    if (!active || !selected) return;
    if (deferPreview) return;
    const cached = fileCache.current.get(selected);
    if (cached) {
      setFile({ path: selected, content: cached });
      return;
    }
    wantedFile.current = { path: selected };
    void requestFile();
  }, [selected, active, revision, requestFile, deferPreview]);

  return {
    directories,
    changes,
    file,
    error: changesError || fileError || error,
    directoryError: error,
    changesError,
    fileError,
    refreshing,
    contentRevision,
    refresh,
    preload: loadDirectory,
  };
}
