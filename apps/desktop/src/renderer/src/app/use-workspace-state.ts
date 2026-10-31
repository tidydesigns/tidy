import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { z } from "zod";
import type {
  DesktopAPI,
  DesktopEvent,
  HarnessConnection,
  LocalDesign,
  Project,
  ProjectSnapshot,
  Thread,
  Bootstrap,
} from "../../../shared/contracts/desktop";
import {
  applyProjectEvent,
  applyThreadPatch,
  retainThreadPullRequests,
} from "../../../shared/models/thread-updates";
import { NavigationScope, useSessionState } from "./session-state";
import { readSidebarCache, writeSidebarCache } from "./sidebar-cache";
import { errorText, type WorkspaceError } from "./workspace-error";

export function useWorkspaceState({
  api,
  navigation,
  onError,
  initial,
  initialThreads,
  connection,
}: {
  api:
    | (Pick<DesktopAPI, "bootstrap" | "selectProject" | "readThread" | "onEvent"> &
        Partial<Pick<DesktopAPI, "checkHarnesses">>)
    | undefined;
  navigation: RefObject<number>;
  onError: (error: WorkspaceError) => void;
  initial?: Bootstrap;
  initialThreads?: Thread[];
  connection?: string;
}) {
  const scope = useContext(NavigationScope);
  const [cached] = useState(() => {
    const value = !initial && api ? readSidebarCache(scope) : undefined;
    if (!value) return undefined;
    let projectId: string | null | undefined = value.activeProject?.project.id;
    try {
      const saved = sessionStorage.getItem(`tidy:navigation:${scope ? `${scope}:` : ""}project`);
      if (saved !== null) {
        const parsed = z.string().uuid().nullable().safeParse(JSON.parse(saved));
        if (parsed.success) projectId = parsed.data;
      }
    } catch {}
    return { ...value, projectId };
  });
  const initialWorkspace = initial ?? cached;
  const initialBootstrap = useRef(initial);
  const loaded = useRef(Boolean(initial));
  const [loading, setLoading] = useState(!initial);
  const [projects, setProjects] = useState<Project[]>(initialWorkspace?.projects ?? []);
  const [activeProjectId, setActiveProjectId] = useSessionState(
    "project",
    z.string().nullable(),
    initialWorkspace?.activeProject?.project.id ?? null,
    initial?.activeProject?.project.id ?? cached?.projectId,
  );
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>(() =>
    initialWorkspace?.activeProject
      ? { [initialWorkspace.activeProject.project.id]: initialWorkspace.activeProject }
      : {},
  );
  const [harnesses, setHarnesses] = useState<HarnessConnection[]>(initial?.harnesses ?? []);
  const [harnessDiscoveryFailed, setHarnessDiscoveryFailed] = useState(false);
  const [threads, setThreads] = useState<Record<string, Thread>>(() =>
    Object.fromEntries((initialThreads ?? []).map((thread) => [thread.id, thread])),
  );
  const currentThreads = useRef(threads);
  useLayoutEffect(() => {
    currentThreads.current = threads;
  }, [threads]);
  const reads = useRef(new Map<string, Promise<Thread>>());
  const [designs, setDesigns] = useState<Record<string, LocalDesign>>({});
  const activeSnapshot = activeProjectId ? snapshots[activeProjectId] : undefined;

  useEffect(() => {
    if (loading || !api) return;
    const persist = () =>
      writeSidebarCache({
        scope,
        projects,
        activeProject: activeSnapshot ?? null,
      });
    const timer = setTimeout(persist, 200);
    window.addEventListener("pagehide", persist);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", persist);
    };
  }, [scope, projects, activeSnapshot, loading, api]);

  const readThread = useCallback(
    ({ projectId, threadId }: { projectId: string; threadId: string }): Promise<Thread> => {
      const cached = currentThreads.current[threadId];
      if (cached?.projectId === projectId) return Promise.resolve(cached);
      const key = `${projectId}:${threadId}`;
      const pending = reads.current.get(key);
      if (pending) return pending;
      if (!api) return Promise.reject(new Error("Desktop API unavailable."));
      const request = api.readThread(projectId, threadId).then((value) => {
        setThreads((current) => {
          const previous = current[value.id];
          return previous && previous.revision >= value.revision
            ? current
            : { ...current, [value.id]: value };
        });
        return value;
      });
      reads.current.set(key, request);
      void request
        .finally(() => {
          if (reads.current.get(key) === request) reads.current.delete(key);
        })
        .catch(() => {});
      return request;
    },
    [api],
  );

  function applySnapshot(value: ProjectSnapshot, activate = true, expected?: ProjectSnapshot) {
    if (!value.project.cloud) {
      loaded.current = true;
      setLoading(false);
    }
    setSnapshots((current) => {
      const previous = current[value.project.id];
      if (expected && !previous) return current;
      const changed = expected && previous !== expected;
      const expectedThreads = changed
        ? new Map(expected.threads.map((item) => [item.id, item]))
        : undefined;
      const summaries = new Map(value.threads.map((item) => [item.id, item]));
      for (const item of previous?.threads ?? []) {
        const incoming = summaries.get(item.id);
        const revision = incoming?.revision ?? -1;
        if (
          revision < item.revision ||
          (revision === item.revision && expectedThreads && expectedThreads.get(item.id) !== item)
        )
          summaries.set(item.id, item);
        else if (incoming) summaries.set(item.id, retainThreadPullRequests(item, incoming));
      }
      return {
        ...current,
        [value.project.id]: {
          ...value,
          // Preserve intervening edits without discarding unrelated refreshed fields.
          ...(changed && previous
            ? {
                project: previous.project !== expected.project ? previous.project : value.project,
                designs: previous.designs !== expected.designs ? previous.designs : value.designs,
                folders: previous.folders !== expected.folders ? previous.folders : value.folders,
              }
            : {}),
          threads: [...summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        },
      };
    });
    if (value.project.cloud) return;
    setProjects((current) => [
      value.project,
      ...current.filter((item) => item.id !== value.project.id),
    ]);
    if (activate) setActiveProjectId(value.project.id);
  }

  useEffect(() => {
    if (!api) {
      setLoading(false);
      return;
    }
    let mounted = true;
    const restoreClearedProject = !loaded.current && cached?.projectId === null;
    const refresh = connection !== "offline" || !loaded.current;
    let bootstrapping = refresh;
    const initialEvents = new Map<string, Exclude<DesktopEvent, { type: "repository-change" }>>();
    const unsubscribe = api.onEvent((event) => {
      if (!mounted || event.type === "repository-change") return;
      if (bootstrapping) {
        const key = event.type === "designs" ? event.projectId : event.thread.id;
        const previous = initialEvents.get(key);
        if (
          event.type === "designs" ||
          !previous ||
          previous.type === "designs" ||
          previous.thread.revision <= event.thread.revision
        )
          initialEvents.set(key, event);
      }
      if (event.type === "thread" || event.type === "thread-patch") {
        const value = event.thread;
        setThreads((current) => {
          const previous = current[value.id];
          if (event.type === "thread-patch") {
            if (!previous) return current;
            const next = applyThreadPatch(previous, event);
            return next === previous ? current : { ...current, [value.id]: next };
          }
          if (previous && previous.revision > value.revision) return current;
          return { ...current, [value.id]: event.thread };
        });
      }
      const projectId = event.type === "designs" ? event.projectId : event.thread.projectId;
      setSnapshots((current) => {
        const entry = current[projectId];
        if (!entry) return current;
        const next = applyProjectEvent(entry, event);
        return next === entry ? current : { ...current, [projectId]: next };
      });
    });
    if (!refresh) {
      initialBootstrap.current = undefined;
      setLoading(false);
      return () => {
        mounted = false;
        unsubscribe();
      };
    }
    let harnessesRefreshed = false;
    setHarnessDiscoveryFailed(false);
    void api
      .checkHarnesses?.()
      .then((value) => {
        if (!mounted) return;
        harnessesRefreshed = true;
        setHarnesses(value);
        setHarnessDiscoveryFailed(false);
      })
      .catch((cause: unknown) => {
        if (mounted) {
          setHarnessDiscoveryFailed(true);
          onError({ text: errorText(cause), original: cause });
        }
      });
    const initialNavigation = navigation.current;
    const prepared = initialBootstrap.current;
    initialBootstrap.current = undefined;
    void (prepared ? Promise.resolve(prepared) : api.bootstrap())
      .then(async (value) => {
        if (!mounted) return;
        loaded.current = true;
        setProjects(value.projects.filter((p) => !p.cloud));
        if (!harnessesRefreshed) setHarnesses(value.harnesses);
        let activeProject = value.activeProject;
        if (
          navigation.current === initialNavigation &&
          !prepared &&
          activeProjectId &&
          value.projects.some((p) => p.id === activeProjectId && !p.cloud) &&
          activeProject?.project.id !== activeProjectId
        ) {
          try {
            activeProject = await api.selectProject(activeProjectId);
          } catch (cause) {
            if (mounted && navigation.current === initialNavigation)
              onError({
                text: "Could not reopen the previous project. Choose a recent project or open its folder again.",
                original: cause,
              });
          }
        }
        if (!mounted) return;
        if (navigation.current === initialNavigation) {
          if (restoreClearedProject) setActiveProjectId(null);
          else if (activeProject && !activeProject.project.cloud) {
            const snapshot = [...initialEvents.values()].reduce(applyProjectEvent, activeProject);
            setSnapshots((current) => {
              const previous = new Map(
                current[snapshot.project.id]?.threads.map((item) => [item.id, item]),
              );
              return {
                ...current,
                [snapshot.project.id]: {
                  ...snapshot,
                  threads: snapshot.threads.map((item) =>
                    retainThreadPullRequests(previous.get(item.id), item),
                  ),
                },
              };
            });
            setActiveProjectId(snapshot.project.id);
          } else setActiveProjectId(null);
        }
        bootstrapping = false;
        initialEvents.clear();
      })
      .catch((value) => {
        if (mounted) onError({ text: errorText(value), original: value });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api, connection]);

  return {
    loading,
    bootstrapped: loaded.current,
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
    snapshots,
    setSnapshots,
    harnesses,
    setHarnesses,
    harnessDiscoveryFailed,
    setHarnessDiscoveryFailed,
    threads,
    readThread,
    setThreads,
    designs,
    setDesigns,
    applySnapshot,
  };
}
