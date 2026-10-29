import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
import { applyProjectEvent, applyThreadPatch } from "../../../shared/models/thread-updates";
import { useSessionState } from "./session-state";
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
  const initialBootstrap = useRef(initial);
  const loaded = useRef(Boolean(initial));
  const [loading, setLoading] = useState(!initial);
  const [projects, setProjects] = useState<Project[]>(initial?.projects ?? []);
  const [activeProjectId, setActiveProjectId] = useSessionState(
    "project",
    z.string().nullable(),
    initial?.activeProject?.project.id ?? null,
    initial?.activeProject?.project.id,
  );
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>(() =>
    initial?.activeProject ? { [initial.activeProject.project.id]: initial.activeProject } : {},
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
    setSnapshots((current) => {
      // A background refresh must not erase edits or events received since it began.
      if (expected && current[value.project.id] !== expected) return current;
      const summaries = new Map(value.threads.map((item) => [item.id, item]));
      for (const item of current[value.project.id]?.threads ?? []) {
        if ((summaries.get(item.id)?.revision ?? -1) < item.revision) summaries.set(item.id, item);
      }
      return {
        ...current,
        [value.project.id]: {
          ...value,
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
    const refresh = connection !== "offline" || !loaded.current;
    let bootstrapping = refresh;
    const initialEvents = new Map<string, DesktopEvent>();
    const unsubscribe = api.onEvent((event) => {
      if (!mounted) return;
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
          if (activeProject && !activeProject.project.cloud) {
            const snapshot = [...initialEvents.values()].reduce(applyProjectEvent, activeProject);
            setSnapshots((current) => ({ ...current, [snapshot.project.id]: snapshot }));
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
