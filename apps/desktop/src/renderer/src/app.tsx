import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { TidyLogo } from "@tidy/ui/tidy-logo";
import { Icon } from "@tidy/editor/components/ui/icon";
import { LocalCanvas } from "./local-canvas";
import { Conversation } from "./conversation";
import { ThreadSidebar, type ThreadOrderControls } from "./thread-sidebar";
import { ApprovalRequests } from "./approval-requests";
import { AttachmentList } from "./message-attachments";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type AttachedFile,
} from "../../shared/attachments";
import { ProjectFiles } from "./project-files";
import { HarnessControls } from "./harness-controls";
import { ThreadCard } from "./thread-card";
import type { HarnessDetails, HarnessSettings } from "../../shared/harness-settings";
import { summarizeThread, applyThreadPatch, applyProjectEvent } from "../../shared/thread-updates";
import type {
  DesktopEvent,
  DesignSummary,
  HarnessConnection,
  HarnessId,
  LocalDesign,
  Project,
  ProjectSnapshot,
  Thread,
  ThreadSummary,
} from "../../shared/contracts";

const modes = [
  { id: "design", label: "Design" },
  { id: "code", label: "Code" },
] as const;
type Mode = (typeof modes)[number]["id"];
type Draft = {
  text: string;
  harness: HarnessId;
  designIds: string[];
  settings?: HarnessSettings;
  attachments?: AttachedFile[];
};
const emptyDraft: Draft = { text: "", harness: "codex", designIds: [] };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The operation could not be completed.";

export function App() {
  const api = window.tidy;
  const [mode, setMode] = useState<Mode>("design");
  const [designNavigation, setDesignNavigation] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const projectFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (opening) return;
    const previous = projectFocus.current;
    projectFocus.current = null;
    if (previous?.isConnected && document.activeElement === document.body) previous.focus();
  }, [opening]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({});
  const [harnesses, setHarnesses] = useState<HarnessConnection[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [selectedThreads, setSelectedThreads] = useState<Record<string, string | null>>({});
  const [selectedDesigns, setSelectedDesigns] = useState<Record<string, string | null>>({});
  const [designs, setDesigns] = useState<Record<string, LocalDesign>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [harnessDetails, setHarnessDetails] = useState<
    Record<string, { info?: HarnessDetails; error?: string; loading: boolean }>
  >({});
  const [settingsPending, setSettingsPending] = useState<Record<string, boolean>>({});
  const detailRequests = useRef<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const [updatingDone, setUpdatingDone] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const sendingKeys = useRef(new Set<string>());
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const uploads = useRef<Record<string, Promise<void>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<{
    projectId?: string;
    text: string;
  } | null>(null);
  const navigation = useRef(0);
  const threadSelection = useRef<Record<string, number>>({});
  const snapshot = activeProjectId ? snapshots[activeProjectId] : undefined;
  const project = snapshot?.project;
  const selectedThreadId = project ? selectedThreads[project.id] : null;
  const thread = selectedThreadId ? threads[selectedThreadId] : undefined;
  const draftKey = `${project?.id ?? ""}:${selectedThreadId ?? "new"}`;
  const readyHarness = harnesses.find((item) => item.status === "ready")?.id ?? "codex";
  const draft = drafts[draftKey] ?? { ...emptyDraft, harness: readyHarness };
  const designSnapshot = useMemo(
    () => (snapshot ? { ...snapshot, threads: [] } : undefined),
    [snapshot?.project, snapshot?.designs, snapshot?.folders],
  );
  const selectedDesignId = project ? selectedDesigns[project.id] : null;
  const backToFiles = useCallback(() => {
    if (project) setSelectedDesigns((current) => ({ ...current, [project.id]: null }));
  }, [project?.id]);
  const design =
    selectedDesignId && snapshot?.designs.some((item) => item.id === selectedDesignId)
      ? designs[selectedDesignId]
      : undefined;
  const running = thread?.status === "running";
  const busy = Boolean(sending[draftKey] && !running);

  const selectedHarness = thread?.harness ?? draft.harness;
  const harnessReady = harnesses.some(
    (item) => item.id === selectedHarness && item.status === "ready",
  );
  const detailKey = `${project?.id ?? ""}:${selectedHarness}`;
  const currentDetails = harnessDetails[detailKey];

  async function loadHarnessDetails(projectId: string, harness: HarnessId, refresh = false) {
    if (!api) return;
    const key = `${projectId}:${harness}`;
    const version = (detailRequests.current[key] ?? 0) + 1;
    detailRequests.current[key] = version;
    setHarnessDetails((current) => ({
      ...current,
      [key]: { ...current[key], loading: true, error: undefined },
    }));
    try {
      const info = await api.harnessDetails(projectId, harness, refresh);
      if (detailRequests.current[key] === version)
        setHarnessDetails((current) => ({
          ...current,
          [key]: { info, loading: false },
        }));
    } catch (cause) {
      if (detailRequests.current[key] === version)
        setHarnessDetails((current) => ({
          ...current,
          [key]: { ...current[key], error: errorText(cause), loading: false },
        }));
    }
  }
  useEffect(() => {
    if (api && project && harnessReady) void loadHarnessDetails(project.id, selectedHarness);
  }, [api, project?.id, selectedHarness, harnessReady]);

  async function changeSettings(settings: HarnessSettings) {
    if (!thread) {
      updateDraft({ settings });
      return;
    }
    if (!api || !project || running || settingsPending[thread.id]) return;
    const previous = thread,
      projectId = project.id;
    const optimistic = { ...thread, settings, revision: thread.revision + 1 };
    const apply = (value: Thread) => {
      setThreads((current) =>
        (current[value.id]?.revision ?? -1) > value.revision
          ? current
          : { ...current, [value.id]: value },
      );
      setSnapshots((current) => {
        const entry = current[projectId];
        return !entry
          ? current
          : {
              ...current,
              [projectId]: {
                ...entry,
                threads: entry.threads.map((item) =>
                  item.id === value.id && item.revision <= value.revision
                    ? summarizeThread(value)
                    : item,
                ),
              },
            };
      });
    };
    setSettingsPending((current) => ({ ...current, [thread.id]: true }));
    apply(optimistic);
    try {
      apply(await api.setThreadSettings(projectId, thread.id, settings));
    } catch (cause) {
      const matches = (value: ThreadSummary) =>
        value.revision === optimistic.revision &&
        value.status === optimistic.status &&
        JSON.stringify(value.settings) === JSON.stringify(settings);
      setThreads((current) =>
        current[previous.id] && matches(current[previous.id])
          ? { ...current, [previous.id]: previous }
          : current,
      );
      setSnapshots((current) => {
        const entry = current[projectId];
        return !entry
          ? current
          : {
              ...current,
              [projectId]: {
                ...entry,
                threads: entry.threads.map((item) =>
                  item.id === previous.id && matches(item) ? summarizeThread(previous) : item,
                ),
              },
            };
      });
      setError({ projectId, text: errorText(cause) });
    } finally {
      setSettingsPending((current) => ({ ...current, [previous.id]: false }));
    }
  }

  useEffect(() => {
    const updateTime = () => setNow(Date.now());
    const timer = window.setInterval(updateTime, 60_000);
    window.addEventListener("focus", updateTime);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", updateTime);
    };
  }, []);

  function updateDraft(patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...draft, ...patch },
    }));
  }

  function selectThread(projectId: string, threadId: string | null) {
    threadSelection.current[projectId] = (threadSelection.current[projectId] ?? 0) + 1;
    setSelectedThreads((current) => ({ ...current, [projectId]: threadId }));
  }

  function applySnapshot(value: ProjectSnapshot) {
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
    setProjects((current) => [
      value.project,
      ...current.filter((item) => item.id !== value.project.id),
    ]);
    setActiveProjectId(value.project.id);
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
          if (event.type === "thread-patch")
            return previous
              ? { ...current, [value.id]: applyThreadPatch(previous, event) }
              : current;
          return {
            ...current,
            [value.id]: (previous?.revision ?? -1) > value.revision ? previous : event.thread,
          };
        });
      }
      const projectId = event.type === "designs" ? event.projectId : event.thread.projectId;
      setSnapshots((current) => {
        const entry = current[projectId];
        return entry ? { ...current, [projectId]: applyProjectEvent(entry, event) } : current;
      });
    });
    void api
      .bootstrap()
      .then((value) => {
        if (!mounted) return;
        setProjects(value.projects);
        setHarnesses(value.harnesses);
        if (value.activeProject) {
          const snapshot = [...initialEvents.values()].reduce(
            applyProjectEvent,
            value.activeProject,
          );
          setSnapshots((current) => ({ ...current, [snapshot.project.id]: snapshot }));
          setActiveProjectId(value.activeProject.project.id);
        }
        bootstrapping = false;
        initialEvents.clear();
      })
      .catch((value) => {
        if (mounted) setError({ text: errorText(value) });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!api || !project || !selectedThreadId || threads[selectedThreadId]) return;
    let active = true;
    void api
      .readThread(project.id, selectedThreadId)
      .then((value) => {
        if (active)
          setThreads((current) => ({
            ...current,
            [value.id]: current[value.id] ?? value,
          }));
      })
      .catch((value) => {
        if (active) setError({ projectId: project.id, text: errorText(value) });
      });
    return () => {
      active = false;
    };
  }, [api, project, selectedThreadId, threads]);

  useEffect(() => {
    if (
      !api ||
      !project ||
      !selectedDesignId ||
      designs[selectedDesignId] ||
      !snapshot?.designs.some((item) => item.id === selectedDesignId)
    )
      return;
    let active = true;
    void api
      .readDesign(project.id, selectedDesignId)
      .then((value) => {
        if (active) setDesigns((current) => ({ ...current, [value.id]: value }));
      })
      .catch((value) => {
        if (active) setError({ projectId: project.id, text: errorText(value) });
      });
    return () => {
      active = false;
    };
  }, [api, project, selectedDesignId, designs, snapshot?.designs]);

  async function chooseProject(projectId?: string) {
    if (!api || opening) return;
    projectFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const generation = ++navigation.current;
    setOpening(true);
    setError(null);
    try {
      const value = projectId ? await api.selectProject(projectId) : await api.openProject();
      if (value && navigation.current === generation) applySnapshot(value);
    } catch (value) {
      setError({ text: errorText(value) });
    } finally {
      if (navigation.current === generation) setOpening(false);
    }
  }

  const updateLocalDesign = useCallback(
    (value: LocalDesign) => {
      setDesigns((current) => ({ ...current, [value.id]: value }));
      setSnapshots((current) => {
        const entry = current[activeProjectId!];
        if (!entry) return current;
        const summary: DesignSummary = {
          id: value.id,
          name: value.name,
          path: value.path,
          updatedAt: value.updatedAt,
          folderId: value.folderId,
          nodeCount: value.nodeCount,
        };
        return {
          ...current,
          [entry.project.id]: {
            ...entry,
            designs: [summary, ...entry.designs.filter((item) => item.id !== value.id)].sort(
              (a, b) => b.updatedAt.localeCompare(a.updatedAt),
            ),
          },
        };
      });
    },
    [activeProjectId],
  );

  function attachFiles(files: File[]) {
    if (!api || !project || thread?.doneAt || busy || !files.length) return;
    const projectId = project.id,
      key = draftKey,
      fallback = draft;
    setUploading((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
    const queued = (uploads.current[key] ?? Promise.resolve())
      .then(async () => {
        const attached = [...(draftsRef.current[key]?.attachments ?? fallback.attachments ?? [])];
        const errors: string[] = [];
        for (const file of files) {
          if (attached.length >= MAX_ATTACHMENTS) {
            errors.push("Attach up to 10 files per message.");
            break;
          }
          const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
          if (file.size > (image ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES)) {
            errors.push(
              `${file.name}: choose ${image ? "an image under 5 MB" : "a file under 20 MB"}.`,
            );
            continue;
          }
          if (
            attached.reduce((total, value) => total + value.size, file.size) >
            MAX_ATTACHMENT_TOTAL_BYTES
          ) {
            errors.push("Keep attachments under 25 MB per message.");
            continue;
          }
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(new Error("Could not read this file."));
              reader.readAsDataURL(file);
            });
            const value = await api.addAttachment(
              projectId,
              file.name.slice(0, 200) || "Pasted image.png",
              dataUrl,
            );
            attached.push(value);
            setDrafts((current) => ({
              ...current,
              [key]: {
                ...(current[key] ?? fallback),
                attachments: [...(current[key]?.attachments ?? fallback.attachments ?? []), value],
              },
            }));
          } catch (cause) {
            errors.push(errorText(cause));
          }
        }
        if (errors.length) setError({ projectId, text: [...new Set(errors)].join(" ") });
      })
      .finally(() => {
        setUploading((current) => ({
          ...current,
          [key]: Math.max(0, (current[key] ?? 1) - 1),
        }));
      });
    uploads.current[key] = queued.catch(() => {});
  }

  async function send() {
    if (
      !api ||
      !project ||
      (!draft.text.trim() && !draft.attachments?.length) ||
      !harnessReady ||
      (selectedThreadId && !thread) ||
      sendingKeys.current.has(draftKey) ||
      uploading[draftKey] ||
      busy ||
      running ||
      thread?.doneAt ||
      (thread && settingsPending[thread.id])
    )
      return;
    const projectId = project.id;
    const key = draftKey;
    const submitted = draft.text;
    const selection = threadSelection.current[projectId] ?? 0;
    const id = selectedThreadId ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const pendingKey = `${projectId}:${id}`;
    const optimistic: Thread = {
      ...(thread ?? {
        id,
        projectId,
        harness: draft.harness,
        settings: draft.settings,
        title:
          submitted.replace(/\s+/g, " ").slice(0, 80) ||
          draft.attachments?.[0]?.name ||
          "New thread",
        designIds: draft.designIds,
        messages: [],
        revision: 0,
      }),
      revision: (thread?.revision ?? 0) + 1,
      messages: [
        ...(thread?.messages ?? []),
        {
          id: messageId,
          role: "user",
          text: submitted,
          ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
        },
      ],
      status: "running",
      activity: "Starting",
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    sendingKeys.current.add(key);
    setSending((current) => ({ ...current, [key]: true }));
    setThreads((current) => ({ ...current, [id]: optimistic }));
    setSnapshots((current) => {
      const entry = current[projectId];
      return entry
        ? {
            ...current,
            [projectId]: {
              ...entry,
              threads: [
                summarizeThread(optimistic),
                ...entry.threads.filter((item) => item.id !== id),
              ],
            },
          }
        : current;
    });
    setDrafts((current) => ({
      ...current,
      [key]: { ...draft, text: "", attachments: [] },
      ...(id !== selectedThreadId ? { [pendingKey]: { ...draft, text: "", attachments: [] } } : {}),
    }));
    setSelectedThreads((current) => ({ ...current, [projectId]: id }));
    setError(null);
    try {
      const value = selectedThreadId
        ? await api.sendMessage({
            projectId,
            threadId: id,
            messageId,
            text: submitted,
            attachmentIds: draft.attachments?.map((file) => file.id),
          })
        : await api.startThread({
            projectId,
            threadId: id,
            messageId,
            harness: draft.harness,
            prompt: submitted,
            designIds: draft.designIds,
            settings: draft.settings,
            attachmentIds: draft.attachments?.map((file) => file.id),
          });
      setThreads((current) => ({
        ...current,
        [value.id]:
          (current[value.id]?.revision ?? -1) > value.revision ? current[value.id] : value,
      }));
      if ((threadSelection.current[projectId] ?? 0) === selection)
        setSelectedThreads((current) => ({
          ...current,
          [projectId]: value.id,
        }));
    } catch (value) {
      // Remove only this pending turn. Preserve navigation, newer drafts and native events.
      setThreads((current) => {
        if (
          current[id]?.revision !== optimistic.revision ||
          current[id]?.updatedAt !== optimistic.updatedAt
        )
          return current;
        const next = { ...current };
        if (thread) next[id] = thread;
        else delete next[id];
        return next;
      });
      setSnapshots((current) => {
        const entry = current[projectId];
        if (!entry) return current;
        return {
          ...current,
          [projectId]: {
            ...entry,
            threads: entry.threads.flatMap((item) =>
              item.id !== id ||
              item.revision !== optimistic.revision ||
              item.updatedAt !== optimistic.updatedAt
                ? [item]
                : thread
                  ? [summarizeThread(thread)]
                  : [],
            ),
          },
        };
      });
      setDrafts((current) => ({
        ...current,
        [key]: {
          ...draft,
          ...(current[key] ?? {}),
          text: [
            submitted,
            current[key]?.text,
            ...(pendingKey !== key ? [current[pendingKey]?.text] : []),
          ]
            .filter(Boolean)
            .join("\n\n"),
          attachments: [
            ...(draft.attachments ?? []),
            ...(current[key]?.attachments ?? []),
            ...(pendingKey !== key ? (current[pendingKey]?.attachments ?? []) : []),
          ].filter((file, index, all) => all.findIndex((item) => item.id === file.id) === index),
        },
      }));
      if (!thread)
        setSelectedThreads((current) =>
          current[projectId] === id ? { ...current, [projectId]: null } : current,
        );
      setError({ projectId, text: errorText(value) });
    } finally {
      sendingKeys.current.delete(key);
      setSending((current) => ({ ...current, [key]: false }));
    }
  }

  async function toggleThreadDone(item: ThreadSummary) {
    if (!api || !project || updatingDone[item.id] || item.status === "running") return;
    const projectId = project.id;
    const next = {
      ...item,
      revision: item.revision + 1,
      doneAt: item.doneAt ? undefined : new Date().toISOString(),
    };
    function apply(summary: ThreadSummary) {
      setSnapshots((current) => {
        const entry = current[projectId];
        if (!entry) return current;
        return {
          ...current,
          [projectId]: {
            ...entry,
            threads: entry.threads.map((value) =>
              value.id === summary.id && value.revision <= summary.revision ? summary : value,
            ),
          },
        };
      });
      setThreads((current) => {
        const value = current[summary.id];
        return value && value.revision <= summary.revision
          ? {
              ...current,
              [summary.id]: {
                ...value,
                doneAt: summary.doneAt,
                revision: summary.revision,
              },
            }
          : current;
      });
    }
    setUpdatingDone((current) => ({ ...current, [item.id]: true }));
    apply(next);
    try {
      const value = await api.setThreadDone(projectId, item.id, Boolean(next.doneAt));
      apply(summarizeThread(value));
    } catch (cause) {
      // Roll back only this optimistic change, without undoing a newer thread event.
      const isOptimistic = (value: ThreadSummary) =>
        value.revision === next.revision &&
        value.doneAt === next.doneAt &&
        value.status === next.status;
      setSnapshots((current) => {
        const entry = current[projectId];
        if (!entry) return current;
        return {
          ...current,
          [projectId]: {
            ...entry,
            threads: entry.threads.map((value) =>
              value.id === item.id && isOptimistic(value) ? item : value,
            ),
          },
        };
      });
      setThreads((current) => {
        const value = current[item.id];
        return value && isOptimistic(value)
          ? {
              ...current,
              [item.id]: {
                ...value,
                doneAt: item.doneAt,
                revision: item.revision,
              },
            }
          : current;
      });
      setError({ projectId, text: errorText(cause) });
    } finally {
      setUpdatingDone((current) => ({ ...current, [item.id]: false }));
    }
  }

  async function stop() {
    if (!api || !project || !thread) return;
    try {
      await api.stopThread(project.id, thread.id);
    } catch (value) {
      setError({ projectId: project.id, text: errorText(value) });
    }
  }

  async function refreshHarnesses() {
    if (!api) return;
    try {
      setHarnesses(await api.checkHarnesses());
    } catch (value) {
      setError({ text: errorText(value) });
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % modes.length
        : event.key === "ArrowLeft"
          ? (index + modes.length - 1) % modes.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? modes.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setMode(modes[next].id);
    document.getElementById(`workspace-tab-${modes[next].id}`)?.focus();
  }

  const renderThread = (item: ThreadSummary, orderControls?: ThreadOrderControls) => (
    <ThreadCard
      key={item.id}
      thread={item}
      orderControls={orderControls}
      selected={selectedThreadId === item.id}
      now={now}
      pending={Boolean(updatingDone[item.id] || settingsPending[item.id])}
      onSelect={() => selectThread(project!.id, item.id)}
      onDone={() => void toggleThreadDone(item)}
      modelName={
        harnessDetails[`${project?.id}:${item.harness}`]?.info?.models.find(
          (model) => model.id === (item.settings?.model ?? item.actualModel),
        )?.name
      }
      designNames={item.designIds.map(
        (id) => snapshot?.designs.find((design) => design.id === id)?.name ?? "Design reference",
      )}
    />
  );
  const visibleError = error && (!error.projectId || error.projectId === activeProjectId);

  const projectFiles = useMemo(() => {
    const project = designSnapshot?.project;
    if (!api || !designSnapshot || !project) return null;
    return (
      <ProjectFiles
        key={project.id}
        api={api}
        snapshot={designSnapshot}
        navigationTarget={designNavigation}
        onOpen={(id) => setSelectedDesigns((current) => ({ ...current, [project.id]: id }))}
        onCreated={(value) => {
          updateLocalDesign(value);
          setSelectedDesigns((current) => ({
            ...current,
            [project.id]: value.id,
          }));
        }}
        onUpdate={updateLocalDesign}
        onFolderUpdate={(folder) =>
          setSnapshots((current) => {
            const entry = current[project.id];
            return {
              ...current,
              [project.id]: {
                ...entry,
                folders: [folder, ...(entry.folders ?? []).filter((item) => item.id !== folder.id)],
              },
            };
          })
        }
      />
    );
  }, [api, designSnapshot, designNavigation, updateLocalDesign]);

  return (
    <div className={`desktop ${mode === "design" && design ? "desktop-canvas-focused" : ""}`}>
      <aside
        className="desktop-navigation"
        aria-label="Project workspace"
        hidden={mode === "design" && Boolean(design)}
      >
        <header className="workspace-header">
          <div className="project-picker" title={project?.name}>
            {project && (
              <SelectMenu
                value={project.id}
                options={[
                  ...projects.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                  { value: "open", label: "Open project…" },
                ]}
                label="Project"
                disabled={opening}
                onChange={(value) => void chooseProject(value === "open" ? undefined : value)}
                triggerClassName="project-trigger"
              />
            )}
          </div>
          <div role="tablist" aria-label="Workspace" className="workspace-tabs">
            {modes.map((item, index) => (
              <Button
                key={item.id}
                id={`workspace-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={mode === item.id}
                aria-controls={`workspace-panel-${item.id}`}
                tabIndex={mode === item.id ? 0 : -1}
                className="workspace-tab"
                onClick={() => setMode(item.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {item.id === "design" ? (
                  <Icon name="frame" size={14} />
                ) : (
                  <svg
                    className="code-mode-icon"
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m6 4-4 4 4 4m4-8 4 4-4 4" />
                  </svg>
                )}
                {item.label}
              </Button>
            ))}
          </div>
        </header>
        {project && snapshot && (
          <>
            <div className="sidebar-mode-content" hidden={mode !== "code"}>
              <ThreadSidebar
                key={project.id}
                projectId={project.id}
                threads={snapshot.threads}
                onNew={() => selectThread(project.id, null)}
                renderThread={renderThread}
              />
            </div>
            <nav
              ref={setDesignNavigation}
              className="design-navigation"
              aria-label="Design folders"
              hidden={mode !== "design"}
            />
          </>
        )}
      </aside>
      {visibleError && (
        <div className="error-banner" role="alert">
          <span>{error.text}</span>
          <Button className="quiet-button" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      <main className="workspace">
        {!project ? (
          <div className="project-home">
            <h1 aria-label="Tidy">
              <TidyLogo className="tidy-logo" />
            </h1>
            {loading ? (
              <p>Opening workspace…</p>
            ) : api ? (
              <>
                <p>Designs and engineering threads, together in your project.</p>
                <Button
                  className="primary-button"
                  disabled={opening}
                  onClick={() => void chooseProject()}
                >
                  {opening ? "Opening…" : "Open project"}
                </Button>
                {projects.length > 0 && (
                  <div className="recent-projects">
                    {projects.map((item) => (
                      <Button
                        key={item.id}
                        className="recent-project"
                        disabled={opening}
                        onClick={() => void chooseProject(item.id)}
                      >
                        <span>{item.name}</span>
                        <small>{item.path}</small>
                      </Button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p>Open Tidy desktop to work with local projects.</p>
            )}
          </div>
        ) : (
          <>
            <section
              id="workspace-panel-design"
              role="tabpanel"
              aria-labelledby="workspace-tab-design"
              hidden={mode !== "design"}
              className="project-workspace canvas-open"
            >
              <div className="design-workspace">
                {design && (
                  <LocalCanvas
                    key={design.id}
                    api={api!}
                    projectId={project.id}
                    initial={design}
                    active={mode === "design"}
                    onBack={backToFiles}
                    onUpdate={updateLocalDesign}
                  />
                )}
                {api && (
                  <div className="project-files-container" hidden={Boolean(design)}>
                    {projectFiles}
                  </div>
                )}
              </div>
            </section>
            <section
              id="workspace-panel-code"
              role="tabpanel"
              aria-labelledby="workspace-tab-code"
              hidden={mode !== "code"}
              className="project-workspace"
            >
              <div className="thread-workspace">
                <div className="content-heading">
                  <h1>{thread?.title ?? (selectedThreadId ? "Opening thread…" : "New thread")}</h1>
                  {thread?.doneAt && (
                    <Button
                      className="quiet-button thread-heading-action"
                      disabled={running || Boolean(updatingDone[thread.id])}
                      onClick={() => void toggleThreadDone(summarizeThread(thread))}
                    >
                      Reopen thread
                    </Button>
                  )}
                </div>
                <Conversation
                  key={`${project.id}:${selectedThreadId ?? "draft"}`}
                  identity={`${project.id}:${selectedThreadId ?? "draft"}`}
                  thread={thread}
                  active={mode === "code"}
                  api={api!}
                  references={
                    thread?.designIds.map(
                      (id) =>
                        snapshot.designs.find((design) => design.id === id)?.name ??
                        "Design reference",
                    ) ?? []
                  }
                />
                {thread?.pendingApprovals?.length && api ? (
                  <ApprovalRequests
                    key={thread.id}
                    requests={thread.pendingApprovals}
                    onRespond={async (id, decision) => {
                      const value = await api.respondToApproval(
                        project.id,
                        thread.id,
                        id,
                        decision,
                      );
                      setThreads((current) => ({
                        ...current,
                        [value.id]:
                          (current[value.id]?.revision ?? -1) > value.revision
                            ? current[value.id]
                            : value,
                      }));
                    }}
                  />
                ) : null}
                <form
                  className="composer"
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes("Files") && !thread?.doneAt)
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (event.dataTransfer.files.length) {
                      event.preventDefault();
                      attachFiles(Array.from(event.dataTransfer.files));
                    }
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  {!thread && snapshot.designs.length > 0 && (
                    <DesignReferences
                      designs={snapshot.designs}
                      selected={draft.designIds}
                      onChange={(designIds) => updateDraft({ designIds })}
                    />
                  )}
                  <AttachmentList
                    files={draft.attachments ?? []}
                    onRemove={
                      thread?.doneAt
                        ? undefined
                        : (id) =>
                            updateDraft({
                              attachments: draft.attachments?.filter((file) => file.id !== id),
                            })
                    }
                  />
                  {Boolean(uploading[draftKey]) && (
                    <span className="attachment-progress" role="status">
                      Adding attachments…
                    </span>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    aria-label="Attach files"
                    onChange={(event) => {
                      attachFiles(Array.from(event.currentTarget.files ?? []));
                      event.currentTarget.value = "";
                    }}
                  />
                  <label className="sr-only" htmlFor="thread-prompt">
                    Message
                  </label>
                  <textarea
                    id="thread-prompt"
                    value={draft.text}
                    onChange={(event) => updateDraft({ text: event.target.value })}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files);
                      if (files.length) {
                        event.preventDefault();
                        attachFiles(files);
                      }
                    }}
                    placeholder={
                      thread?.doneAt
                        ? "Reopen this thread to continue…"
                        : thread
                          ? "Continue this thread…"
                          : "What would you like to work on?"
                    }
                    disabled={Boolean(thread?.doneAt) || busy}
                    maxLength={32_000}
                    rows={3}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.altKey &&
                        !event.nativeEvent.isComposing &&
                        event.nativeEvent.keyCode !== 229
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-actions">
                    <Button
                      type="button"
                      className="quiet-button attachment-button"
                      aria-label="Attach files"
                      title="Attach files"
                      disabled={Boolean(thread?.doneAt) || busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      <svg
                        aria-hidden="true"
                        width="17"
                        height="17"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <path
                          d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </Button>
                    <HarnessControls
                      api={api!}
                      connections={harnesses}
                      harness={selectedHarness}
                      settings={thread?.settings ?? draft.settings ?? {}}
                      actualModel={thread?.actualModel}
                      usage={thread?.usage}
                      details={currentDetails?.info}
                      error={currentDetails?.error}
                      loading={Boolean(currentDetails?.loading)}
                      disabled={Boolean(
                        running || busy || (thread && settingsPending[thread.id]) || thread?.doneAt,
                      )}
                      onHarnessChange={
                        thread ? undefined : (harness) => updateDraft({ harness, settings: {} })
                      }
                      onSettingsChange={(settings) => void changeSettings(settings)}
                      onRefresh={() => {
                        if (project && harnessReady)
                          void loadHarnessDetails(project.id, selectedHarness, true);
                      }}
                    />
                    <span className="composer-spacer" />
                    {running ? (
                      <Button
                        type="button"
                        className="secondary-button"
                        onClick={() => void stop()}
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        className="primary-button"
                        disabled={
                          (!draft.text.trim() && !draft.attachments?.length) ||
                          Boolean(uploading[draftKey]) ||
                          busy ||
                          Boolean(thread && settingsPending[thread.id]) ||
                          Boolean(thread?.doneAt) ||
                          !harnessReady ||
                          Boolean(selectedThreadId && !thread)
                        }
                      >
                        {busy ? "Starting…" : thread ? "Send" : "Start thread"}
                      </Button>
                    )}
                  </div>
                  {!harnessReady && (
                    <div className="connection-help">
                      <span>
                        {harnesses.find((item) => item.id === selectedHarness)?.name ??
                          "Your harness"}{" "}
                        needs to be installed and signed in locally. Run{" "}
                        <code>
                          {selectedHarness === "codex" ? "codex login" : "claude auth login"}
                        </code>{" "}
                        in your terminal.
                      </span>
                      <Button
                        type="button"
                        className="quiet-button"
                        onClick={() => void refreshHarnesses()}
                      >
                        Check connection
                      </Button>
                    </div>
                  )}
                </form>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function DesignReferences({
  designs,
  selected,
  onChange,
}: {
  designs: DesignSummary[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <details className="design-references">
      <summary>Design references{selected.length ? ` (${selected.length})` : ""}</summary>
      <div className="reference-options">
        {designs.map((design) => (
          <Button
            key={design.id}
            type="button"
            aria-pressed={selected.includes(design.id)}
            className="reference-option"
            disabled={!selected.includes(design.id) && selected.length >= 20}
            onClick={() =>
              onChange(
                selected.includes(design.id)
                  ? selected.filter((id) => id !== design.id)
                  : [...selected, design.id],
              )
            }
          >
            <span>{design.name}</span>
            <span aria-hidden="true">{selected.includes(design.id) ? "✓" : "+"}</span>
          </Button>
        ))}
      </div>
    </details>
  );
}
