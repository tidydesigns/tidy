import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type {
  RepositoryChanges,
  RepositoryDirectory,
  RepositoryFile,
} from "../../../../shared/contracts/repository-files";

export type RepositoryAPI = Required<
  Pick<DesktopAPI, "repositoryDirectory" | "repositoryChanges" | "repositoryFile">
> &
  Pick<DesktopAPI, "onEvent">;

export function useRepositoryFiles({
  api,
  projectId,
  active,
  selected,
  expanded,
}: {
  api: RepositoryAPI;
  projectId: string;
  active: boolean;
  selected: string | null;
  expanded: ReadonlySet<string>;
}) {
  const [directories, setDirectories] = useState(new Map<string, RepositoryDirectory>());
  const [changes, setChanges] = useState<RepositoryChanges>();
  const [file, setFile] = useState<{ path: string; content: RepositoryFile }>();
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [changesError, setChangesError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const directoryRequests = useRef(new Map<string, Promise<void>>());
  const directoryCache = useRef(new Map<string, RepositoryDirectory>());
  const directoryFailures = useRef(new Set<string>());
  const fileGeneration = useRef(0);
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

  function rememberDirectoryFailure(path: string) {
    const failures = directoryFailures.current;
    failures.add(path);
    if (failures.size > 128) {
      const first = failures.values().next().value;
      if (first !== undefined) failures.delete(first);
    }
  }

  const loadDirectory = useCallback(
    (path: string, force = false): Promise<void> => {
      if (!lifetime.current || !latest.current.active) return Promise.resolve();
      const pending = directoryRequests.current.get(path);
      if (pending) return force ? pending.then(() => loadDirectory(path, true)) : pending;
      if (!force && directoryCache.current.has(path)) return Promise.resolve();
      if (!force && directoryFailures.current.has(path)) return Promise.resolve();
      if (directoryRequests.current.size >= 4)
        return force
          ? Promise.race(directoryRequests.current.values()).then(() => loadDirectory(path, true))
          : Promise.resolve();
      const request = api
        .repositoryDirectory(projectId, path)
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
          )
            return;
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
            rememberDirectoryFailure(path);
            setError(
              "The folder cache is full. Collapse some folders, then refresh to continue browsing.",
            );
            return;
          }
          directoryFailures.current.delete(path);
          setDirectories(new Map(cache));
        })
        .catch((cause: unknown) => {
          rememberDirectoryFailure(path);
          if (lifetime.current)
            setError(cause instanceof Error ? cause.message : "Could not read this folder.");
        })
        .finally(() => {
          directoryRequests.current.delete(path);
          const next = [...latest.current.expanded].find(
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
  const fileRunning = useRef<string | null>(null);
  const changesInitialized = useRef(false);
  const pendingRefresh = useRef<{ full: boolean; paths: Set<string> } | null>(null);
  const refresh = useCallback(
    async function refresh(paths?: string[]) {
      if (!latest.current.active) return;
      if (refreshingRef.current) {
        const pending = pendingRefresh.current ?? { full: false, paths: new Set<string>() };
        if (!paths) pending.full = true;
        else paths.forEach((path) => pending.paths.add(path));
        pendingRefresh.current = pending;
        return;
      }
      refreshingRef.current = true;
      const initialized = changesInitialized.current;
      let invalidateAll = initialized && !paths;
      const invalidated = new Set(initialized ? paths : []);
      const touches = (path: string) =>
        invalidateAll ||
        [...invalidated].some(
          (parent) => !parent || path === parent || path.startsWith(`${parent}/`),
        );
      changesInitialized.current = true;
      setRefreshing(true);
      setError("");
      try {
        await api.repositoryChanges(projectId).then(
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
            for (const path of new Set([
              ...fileCache.current.keys(),
              ...(latest.current.selected ? [latest.current.selected] : []),
              ...(fileRunning.current ? [fileRunning.current] : []),
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
        if (fileRunning.current && touches(fileRunning.current)) fileGeneration.current += 1;
        for (const path of fileCache.current.keys())
          if (touches(path)) fileCache.current.delete(path);
        if (latest.current.selected && touches(latest.current.selected))
          setRevision((value) => value + 1);
        const targets = (paths ?? ["", ...latest.current.expanded]).filter(knownDirectory);
        for (let index = 0; index < targets.length; index += 4) {
          if (!lifetime.current || !latest.current.active) break;
          await Promise.all(
            targets.slice(index, index + 4).map((path) => loadDirectory(path, true)),
          );
        }
      } catch (cause) {
        if (lifetime.current)
          setError(cause instanceof Error ? cause.message : "Could not refresh this repository.");
      } finally {
        refreshingRef.current = false;
        if (lifetime.current) setRefreshing(false);
        const pending = pendingRefresh.current;
        pendingRefresh.current = null;
        if (pending && lifetime.current && latest.current.active)
          void refresh(pending.full ? undefined : [...pending.paths]);
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
    const timer = setInterval(focus, 15000);
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
      if (fileRunning.current) return;
      const wanted = wantedFile.current;
      if (!wanted || !latest.current.active) return;
      wantedFile.current = null;
      fileRunning.current = wanted.path;
      const generation = fileGeneration.current;
      const previousPath =
        changesRef.current?.changes.find((change) => change.path === wanted.path)?.previousPath ??
        undefined;
      try {
        const content = await api.repositoryFile(projectId, wanted.path, previousPath);
        if (!lifetime.current || generation !== fileGeneration.current) return;
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
          generation === fileGeneration.current &&
          latest.current.selected === wanted.path &&
          !wantedFile.current
        )
          setFileError(
            cause instanceof Error && cause.message ? cause.message : "Could not read this file.",
          );
      } finally {
        fileRunning.current = null;
        if (lifetime.current && wantedFile.current) void run();
      }
    },
    [api, projectId],
  );

  useEffect(() => {
    wantedFile.current = null;
    setFileError("");
    if (!active || !selected) return;
    const cached = fileCache.current.get(selected);
    if (cached) {
      setFile({ path: selected, content: cached });
      return;
    }
    wantedFile.current = { path: selected };
    void requestFile();
  }, [selected, active, revision, requestFile]);

  return {
    directories,
    changes,
    file,
    error: changesError || fileError || error,
    refreshing,
    refresh,
    preload: loadDirectory,
  };
}
