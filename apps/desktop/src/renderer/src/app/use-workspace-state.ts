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
} from "../../../shared/contracts/desktop";
import { applyProjectEvent, applyThreadPatch } from "../../../shared/models/thread-updates";
import { useSessionState } from "./session-state";
import { errorText, type WorkspaceError } from "./workspace-error";

export function useWorkspaceState({
  api,
  navigation,
  onError,
}: {
  api: Pick<DesktopAPI, "bootstrap" | "selectProject" | "readThread" | "onEvent"> | undefined;
  navigation: RefObject<number>;
  onError: (error: WorkspaceError) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useSessionState(
    "project",
    z.string().nullable(),
    null,
  );
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({});
  const [harnesses, setHarnesses] = useState<HarnessConnection[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
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

  function applySnapshot(value: ProjectSnapshot, activate = true) {
    setSnapshots((current) => {
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
    let bootstrapping = true;
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
    const initialNavigation = navigation.current;
    void api
      .bootstrap()
      .then(async (value) => {
        if (!mounted) return;
        setProjects(value.projects.filter((p) => !p.cloud));
        setHarnesses(value.harnesses);
        let activeProject = value.activeProject;
        if (
          navigation.current === initialNavigation &&
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
  }, [api]);

  return {
    loading,
    projects,
    activeProjectId,
    snapshots,
    setSnapshots,
    harnesses,
    setHarnesses,
    threads,
    readThread,
    setThreads,
    designs,
    setDesigns,
    applySnapshot,
  };
}
