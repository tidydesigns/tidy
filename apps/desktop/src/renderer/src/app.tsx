import { z } from "zod";
import { useSessionState } from "./session-state";
import { selectionSchema } from "../../shared/navigation-state";
import { useWorkspaceNavigation } from "./use-workspace-navigation";
import { ComposerContext } from "./composer-context";
import { useRepositoryContext } from "./use-repository-context";
import { SkillPrompt } from "./skill-prompt";
import { skillCommand, type Skill } from "../../shared/skills";
import { errorMessage } from "@tidy/ui/errors";
import { showToast, dismissToast } from "@tidy/ui/toast";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Icon } from "@tidy/editor/components/ui/icon";
import { LocalCanvas } from "./local-canvas";
import { DesktopShell } from "./desktop-shell";
import { Settings } from "./settings";
import { Conversation } from "./conversation";
import { ThreadDesignDock } from "./thread-design-dock";
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
import { MessageQueue } from "./message-queue";
import { MessageActionIcon } from "./message-action-icon";
import { useMessageQueue } from "./use-message-queue";
import { MAX_QUEUED_MESSAGES, type MessageDelivery } from "../../shared/message-queue";
import { AppUpdate } from "./app-update";
import { useCloud } from "./use-cloud";
import { CloudWorkspace } from "./cloud-workspace";
import { SyncStatus } from "./sync-status";
import type { CloudCatalog } from "../../shared/cloud-sync";
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
  cloudFileIds?: string[];
  executionProjectId?: string;
  settings?: HarnessSettings;
  attachments?: AttachedFile[];
  skill?: { id: string; name: string; harness: HarnessId };
};
const emptyDraft: Draft = { text: "", harness: "codex", designIds: [] };
const errorText = (error: unknown) =>
  errorMessage(error, "The operation could not be completed. Please try again.");

export function App() {
  const api = window.tidy;
  const cloud = useCloud(api?.cloud);
  const cloudLibrary = useMemo(
    () => ({ state: cloud.state, account: cloud.account }),
    [cloud.state, cloud.account],
  );
  const [settingsOpen, setSettingsOpen] = useSessionState("settings", z.boolean(), false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen) settingsTrigger.current?.focus();
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen]);
  const {
    target,
    location,
    cloudOrganizationId,
    navigation,
    selectLocalWorkspace,
    selectCloudWorkspace,
  } = useWorkspaceNavigation({
    cloud,
    hasCloudAPI: Boolean(api?.cloud),
  });
  const [cloudCanvas, setCloudCanvas] = useState(false);
  const [mode, setMode] = useSessionState<Mode>("mode", z.enum(["design", "code"]), "design");
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
  const [activeProjectId, setActiveProjectId] = useSessionState(
    "project",
    z.string().nullable(),
    null,
  );
  const cloudKey = `${cloud.account?.id ?? ""}:${cloudOrganizationId}`;
  const [cloudProjects, setCloudProjects] = useState<Record<string, string>>({});
  const [cloudCatalogs, setCloudCatalogs] = useState<Record<string, CloudCatalog>>({});
  const [cloudWorkspaceError, setCloudWorkspaceError] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const rememberCloudCatalog = useCallback(
    (catalog: CloudCatalog) => {
      setCloudCatalogs((current) => ({ ...current, [cloudKey]: catalog }));
    },
    [cloudKey],
  );
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({});
  const [harnesses, setHarnesses] = useState<HarnessConnection[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [selectedThreads, setSelectedThreads] = useSessionState("threads", selectionSchema, {});
  const [selectedDesigns, setSelectedDesigns] = useSessionState("designs", selectionSchema, {});
  const [designs, setDesigns] = useState<Record<string, LocalDesign>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [harnessDetails, setHarnessDetails] = useState<
    Record<string, { info?: HarnessDetails; error?: string; loading: boolean }>
  >({});
  const [skillCatalog, setSkillCatalog] = useState<{
    key: string;
    skills: Skill[];
    status: "loading" | "ready" | "error";
  }>({ key: "", skills: [], status: "loading" });
  const skillRequest = useRef(0);
  const [settingsPending, setSettingsPending] = useState<Record<string, boolean>>({});
  const detailRequests = useRef<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const [updatingDone, setUpdatingDone] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const pendingStarts = useRef(new Map<string, Promise<Thread>>());
  const failedStarts = useRef(new Set<string>());
  const sendingKeys = useRef(new Set<string>());
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const uploads = useRef<Record<string, Promise<void>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const canvasDockHome = useRef<HTMLSpanElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const focusAfterStart = useRef(false);
  const [error, setError] = useState<{
    original?: unknown;
    projectId?: string;
    text: string;
  } | null>(null);
  const threadSelection = useRef<Record<string, number>>({});
  const referenceSelections = useRef(new Map<string, number>());
  const workspaceProjectId = location === "cloud" ? cloudProjects[cloudKey] : activeProjectId;
  const snapshot = workspaceProjectId ? snapshots[workspaceProjectId] : undefined;
  const project = snapshot?.project;
  const reportRepositoryError = useCallback(
    ({ projectId, cause }: { projectId: string; cause: unknown }) =>
      setError({ projectId, text: errorText(cause), original: cause }),
    [],
  );
  const selectedThreadId = project ? selectedThreads[project.id] : null;
  const thread = selectedThreadId ? threads[selectedThreadId] : undefined;
  const draftKey = `${project?.id ?? ""}:${selectedThreadId ?? "new"}`;
  useLayoutEffect(() => {
    if (!focusAfterStart.current) return;
    focusAfterStart.current = false;
    document.getElementById("thread-prompt")?.focus({ preventScroll: true });
  }, [selectedThreadId]);
  const readyHarness = harnesses.find((item) => item.status === "ready")?.id ?? "codex";
  const draft = drafts[draftKey] ?? { ...emptyDraft, harness: readyHarness };
  const selectedSummary = snapshot?.threads.find((item) => item.id === selectedThreadId);
  const executionProjectId = selectedThreadId
    ? (thread?.executionProjectId ?? selectedSummary?.executionProjectId)
    : draft.executionProjectId;
  const executionProject = executionProjectId
    ? projects.find((item) => item.id === executionProjectId)
    : project;
  const {
    repository,
    switching: switchingBranch,
    switchBranch,
  } = useRepositoryContext({
    api,
    projectId: executionProject?.id,
    onError: reportRepositoryError,
  });
  const referenceDesignIds = useMemo(
    () =>
      location === "cloud"
        ? (draft.cloudFileIds ?? []).flatMap((fileId) => {
            const binding = cloud.state?.bindings.find(
              (item) => item.projectId === project?.id && item.fileId === fileId,
            );
            return binding && snapshot?.designs.some((design) => design.id === binding.designId)
              ? [binding.designId]
              : [];
          })
        : draft.designIds,
    [
      location,
      draft.cloudFileIds,
      draft.designIds,
      cloud.state?.bindings,
      project?.id,
      snapshot?.designs,
    ],
  );
  const referencesReady =
    location !== "cloud" || referenceDesignIds.length === (draft.cloudFileIds?.length ?? 0);
  const executionReady = Boolean(executionProject);
  const designSnapshot = useMemo(
    () => (snapshot && !snapshot.project.cloud ? { ...snapshot, threads: [] } : undefined),
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
  const busy = Boolean(sending[draftKey] && thread?.status !== "running");

  const selectedHarness = thread?.harness ?? draft.harness;
  const harnessReady = harnesses.some(
    (item) => item.id === selectedHarness && item.status === "ready",
  );
  const harnessInstalled = harnesses.some(
    (item) => item.id === selectedHarness && item.status !== "not-installed",
  );
  const detailKey = `${executionProject?.id ?? ""}:${selectedHarness}`;

  const queue = useMessageQueue({
    api,
    thread,
    waitForStart: (id) => pendingStarts.current.get(id),
    onThread(value) {
      setThreads((current) =>
        (current[value.id]?.revision ?? -1) > value.revision
          ? current
          : { ...current, [value.id]: value },
      );
      setSnapshots((current) => {
        const entry = current[value.projectId];
        return entry
          ? {
              ...current,
              [value.projectId]: applyProjectEvent(entry, { type: "thread", thread: value }),
            }
          : current;
      });
    },
    onError: (projectId, cause) => setError({ projectId, text: errorText(cause), original: cause }),
    onRecover(target, message) {
      const key = `${target.projectId}:${failedStarts.current.has(target.id) ? "new" : target.id}`;
      setDrafts((current) => {
        const previous = current[key] ?? { ...emptyDraft, harness: target.harness };
        const command = skillCommand(message.text);
        return {
          ...current,
          [key]: {
            ...previous,
            text: [previous.text, message.text].filter(Boolean).join("\n\n"),
            skill: previous.text
              ? previous.skill
              : message.skillId && command
                ? {
                    id: message.skillId,
                    name: command.name,
                    harness: target.harness,
                  }
                : undefined,
            attachments: [...(previous.attachments ?? []), ...(message.attachments ?? [])].filter(
              (file, index, all) => all.findIndex((item) => item.id === file.id) === index,
            ),
          },
        };
      });
    },
  });
  const hasMessage = Boolean(draft.text.trim() || draft.attachments?.length);
  const running = thread?.status === "running" || queue.stopping;
  const submitLabel = busy
    ? "Starting…"
    : running || queue.messages.length
      ? "Queue"
      : thread
        ? "Send"
        : "Start thread";
  const canSend =
    hasMessage &&
    referencesReady &&
    executionReady &&
    !opening &&
    !uploading[draftKey] &&
    !busy &&
    !switchingBranch &&
    !thread?.doneAt &&
    harnessReady &&
    !(selectedThreadId && !thread) &&
    !(thread && settingsPending[thread.id]);

  const availableSkills = skillCatalog.key === detailKey ? skillCatalog.skills : [];
  async function loadSkills(refresh = false) {
    if (!api || !executionProject) return;
    if (!harnessInstalled) {
      setSkillCatalog({ key: detailKey, skills: [], status: "ready" });
      return;
    }
    const request = ++skillRequest.current;
    setSkillCatalog((current) => ({
      key: detailKey,
      skills: current.key === detailKey ? current.skills : [],
      status: "loading",
    }));
    try {
      const catalog = await api.skills(executionProject.id, selectedHarness, refresh);
      if (request === skillRequest.current)
        setSkillCatalog({ key: detailKey, skills: catalog.skills, status: "ready" });
    } catch {
      if (request === skillRequest.current)
        setSkillCatalog((current) => ({
          key: detailKey,
          skills: current.key === detailKey ? current.skills : [],
          status: "error",
        }));
    }
  }
  useEffect(() => {
    void loadSkills();
    const refresh = () => {
      void loadSkills();
    };
    window.addEventListener("focus", refresh);
    return () => {
      skillRequest.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [api, executionProject?.id, selectedHarness, harnessInstalled]);

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
    if (api && executionProject && harnessReady)
      void loadHarnessDetails(executionProject.id, selectedHarness);
  }, [api, executionProject?.id, selectedHarness, harnessReady]);

  useEffect(() => {
    if (!api || !executionProject || thread) return;
    for (const connection of harnesses) {
      if (
        connection.id !== selectedHarness &&
        connection.status === "ready" &&
        !harnessDetails[`${executionProject?.id}:${connection.id}`]
      )
        void loadHarnessDetails(executionProject!.id, connection.id);
    }
  }, [api, executionProject?.id, Boolean(thread), harnesses]);

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
      setError({ projectId, text: errorText(cause), original: cause });
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

  const selectThread = useCallback((projectId: string, threadId: string | null) => {
    threadSelection.current[projectId] = (threadSelection.current[projectId] ?? 0) + 1;
    setSelectedThreads((current) => ({ ...current, [projectId]: threadId }));
  }, []);

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
    if (!api?.cloud || !cloudOrganizationId || !cloud.account?.id) return;
    let active = true;
    setCloudWorkspaceError("");
    void api.cloud
      .openWorkspace(cloudOrganizationId)
      .then((value) => {
        if (!active) return;
        applySnapshot(value, false);
        setCloudProjects((current) => ({ ...current, [cloudKey]: value.project.id }));
      })
      .catch((cause) => {
        if (active) setCloudWorkspaceError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [api, cloudKey, workspaceRetry]);

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
              setError({
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
        if (mounted) setError({ text: errorText(value), original: value });
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
    if (
      mode !== "code" ||
      settingsOpen ||
      !api ||
      !project ||
      !selectedThreadId ||
      threads[selectedThreadId]
    )
      return;
    if (!snapshot?.threads.some((item) => item.id === selectedThreadId)) {
      selectThread(project.id, null);
      return;
    }
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
        if (active) setError({ projectId: project.id, text: errorText(value), original: value });
      });
    return () => {
      active = false;
    };
  }, [api, project, selectedThreadId, threads, location, mode, settingsOpen]);

  useEffect(() => {
    if (
      location !== "local" ||
      mode !== "design" ||
      settingsOpen ||
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
        if (active) setError({ projectId: project.id, text: errorText(value), original: value });
      });
    return () => {
      active = false;
    };
  }, [api, project, selectedDesignId, designs, snapshot?.designs, location, mode, settingsOpen]);

  async function chooseProject(projectId?: string) {
    if (!api || opening) return;
    projectFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const generation = ++navigation.current;
    setOpening(true);
    setError(null);
    try {
      const value = projectId ? await api.selectProject(projectId) : await api.openProject();
      if (value && navigation.current === generation) {
        applySnapshot(value);
        selectLocalWorkspace();
      }
    } catch (value) {
      if (navigation.current === generation) setError({ text: errorText(value), original: value });
    } finally {
      if (navigation.current === generation) setOpening(false);
    }
  }

  async function chooseExecutionProject(value: string) {
    if (!api || !project?.cloud || selectedThreadId || opening) return;
    if (value !== "open") {
      updateDraft({ executionProjectId: value === "design" ? undefined : value, skill: undefined });
      return;
    }
    const key = draftKey;
    const fallback = draft;
    setOpening(true);
    try {
      const opened = await api.openProject();
      if (!opened) return;
      applySnapshot(opened, false);
      setDrafts((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? fallback),
          executionProjectId: opened.project.id,
          skill: undefined,
        },
      }));
    } catch (cause) {
      setError({ text: errorText(cause), original: cause });
    } finally {
      setOpening(false);
    }
  }

  function changeCloudReferences(ids: string[]) {
    if (!api?.cloud || !project || thread) return;
    const key = draftKey;
    const projectId = project.id;
    const fallback = draft;
    updateDraft({ cloudFileIds: ids });
    for (const fileId of new Set([...(draft.cloudFileIds ?? []), ...ids])) {
      if (Boolean(draft.cloudFileIds?.includes(fileId)) === ids.includes(fileId)) continue;
      const selectionKey = `${key}:${fileId}`;
      referenceSelections.current.set(
        selectionKey,
        (referenceSelections.current.get(selectionKey) ?? 0) + 1,
      );
    }
    for (const fileId of ids.filter((id) => !draft.cloudFileIds?.includes(id))) {
      const selectionKey = `${key}:${fileId}`;
      const selection = referenceSelections.current.get(selectionKey);
      void api.cloud
        .openFile(cloudOrganizationId, fileId)
        .then((opened) => {
          if (opened.projectId !== projectId)
            throw new Error("The workspace changed. Attach this design again.");
          const { id, name, path, updatedAt, folderId, nodeCount } = opened.design;
          const summary: DesignSummary = { id, name, path, updatedAt, folderId, nodeCount };
          setSnapshots((current) => {
            const entry = current[projectId];
            if (!entry) return current;
            return {
              ...current,
              [projectId]: {
                ...entry,
                designs: [summary, ...entry.designs.filter((design) => design.id !== summary.id)],
              },
            };
          });
        })
        .catch((cause) => {
          if (referenceSelections.current.get(selectionKey) !== selection) return;
          setDrafts((current) => {
            const latest = current[key] ?? fallback;
            return {
              ...current,
              [key]: {
                ...latest,
                cloudFileIds: latest.cloudFileIds?.filter((id) => id !== fileId),
              },
            };
          });
          setError({ projectId, text: errorText(cause), original: cause });
        });
    }
  }

  const executionContext = project?.cloud
    ? {
        value: executionProjectId ?? "design",
        options: [
          {
            value: "design",
            label: "Design only",
            description: "Work with workspace designs on this computer",
          },
          ...projects.map((item) => ({ value: item.id, label: item.name, description: item.path })),
          ...(executionProjectId && !projects.some((item) => item.id === executionProjectId)
            ? [{ value: executionProjectId, label: "Project unavailable" }]
            : []),
          ...(!selectedThreadId ? [{ value: "open", label: "Open project…" }] : []),
        ],
        ...(!selectedThreadId
          ? { onChange: (value: string) => void chooseExecutionProject(value) }
          : {}),
      }
    : undefined;

  const updateLocalDesign = useCallback(
    (value: LocalDesign) => {
      setDesigns((current) => ({ ...current, [value.id]: value }));
      setSnapshots((current) => {
        const entry = current[workspaceProjectId!];
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
    [workspaceProjectId],
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

  async function send(delivery: MessageDelivery = "queue") {
    if (
      !api ||
      !project ||
      !referencesReady ||
      !executionReady ||
      opening ||
      (!draft.text.trim() && !draft.attachments?.length) ||
      !harnessReady ||
      (selectedThreadId && !thread) ||
      (!running && sendingKeys.current.has(draftKey)) ||
      uploading[draftKey] ||
      busy ||
      switchingBranch ||
      thread?.doneAt ||
      (thread && settingsPending[thread.id])
    )
      return;
    const submitted = draft.text;
    const command = skillCommand(submitted);
    const rememberedSkill =
      draft.skill?.harness === selectedHarness && draft.skill.name === command?.name
        ? draft.skill
        : undefined;
    const selectedSkill =
      rememberedSkill ?? availableSkills.find((skill) => skill.name === command?.name);
    if (
      command &&
      !selectedSkill &&
      (skillCatalog.key !== detailKey || skillCatalog.status !== "ready")
    ) {
      setError({
        projectId: project.id,
        text: "Skills are not available yet. Retry loading skills before sending this command.",
      });
      return;
    }
    if (thread && (running || queue.messages.length > 0)) {
      if (queue.messages.length >= MAX_QUEUED_MESSAGES) {
        setError({
          projectId: project.id,
          text: "The queue is full. Remove a message before adding another.",
        });
        return;
      }
      queue.enqueue(
        {
          id: crypto.randomUUID(),
          text: draft.text,
          attachments: draft.attachments,
          skillId: selectedSkill?.id,
        },
        delivery,
      );
      setDrafts((current) => ({ ...current, [draftKey]: { ...draft, text: "", attachments: [] } }));
      return;
    }
    const projectId = project.id;
    const key = draftKey;
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
        executionProjectId: project.cloud ? draft.executionProjectId : undefined,
        title:
          submitted.replace(/\s+/g, " ").slice(0, 80) ||
          draft.attachments?.[0]?.name ||
          "New thread",
        designIds: referenceDesignIds,
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
    focusAfterStart.current = !thread;
    setSelectedThreads((current) => ({ ...current, [projectId]: id }));
    setError(null);
    try {
      const request = selectedThreadId
        ? api.sendMessage({
            projectId,
            threadId: id,
            messageId,
            text: submitted,
            skillId: selectedSkill?.id,
            attachmentIds: draft.attachments?.map((file) => file.id),
          })
        : api.startThread({
            projectId,
            threadId: id,
            messageId,
            executionProjectId: project.cloud ? draft.executionProjectId : undefined,
            harness: draft.harness,
            prompt: submitted,
            skillId: selectedSkill?.id,
            designIds: referenceDesignIds,
            settings: draft.settings,
            attachmentIds: draft.attachments?.map((file) => file.id),
          });
      pendingStarts.current.set(id, request);
      const value = await request;
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
      if (!thread) failedStarts.current.add(id);
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
      setError({ projectId, text: errorText(value), original: value });
    } finally {
      pendingStarts.current.delete(id);
      sendingKeys.current.delete(key);
      setSending((current) => ({ ...current, [key]: false }));
    }
  }

  const toggleThreadDone = useCallback(
    async (item: ThreadSummary) => {
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
        setError({ projectId, text: errorText(cause), original: cause });
      } finally {
        setUpdatingDone((current) => ({ ...current, [item.id]: false }));
      }
    },
    [api, project, updatingDone],
  );

  async function refreshHarnesses() {
    if (!api) return;
    try {
      setHarnesses(await api.checkHarnesses());
    } catch (value) {
      setError({ text: errorText(value), original: value });
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

  const renderThread = useCallback(
    (item: ThreadSummary, orderControls?: ThreadOrderControls) => (
      <ThreadCard
        thread={item}
        orderControls={orderControls}
        selected={selectedThreadId === item.id}
        now={now}
        pending={Boolean(updatingDone[item.id] || settingsPending[item.id])}
        onSelect={() => selectThread(project!.id, item.id)}
        onDone={() => void toggleThreadDone(item)}
        projectName={project?.name}
        repository={repository}
        modelName={
          harnessDetails[`${project?.id}:${item.harness}`]?.info?.models.find(
            (model) => model.id === (item.actualModel ?? item.settings?.model),
          )?.name
        }
      />
    ),
    [
      selectedThreadId,
      now,
      updatingDone,
      settingsPending,
      selectThread,
      project,
      toggleThreadDone,
      harnessDetails,
      repository,
    ],
  );
  useEffect(() => {
    if (
      !error ||
      (error.projectId &&
        error.projectId !== project?.id &&
        error.projectId !== executionProject?.id)
    )
      return;
    const id = showToast(error.text, "error", () => setError(null), error);
    return () => dismissToast(id);
  }, [error, project?.id, executionProject?.id]);

  const filesActive = !settingsOpen && location === "local" && mode === "design" && !design;
  const projectFiles = useMemo(() => {
    const project = designSnapshot?.project;
    if (!api || !designSnapshot || !project) return null;
    return (
      <ProjectFiles
        key={project.id}
        api={api}
        snapshot={designSnapshot}
        active={filesActive}
        navigationTarget={location === "local" ? designNavigation : null}
        cloud={
          api.cloud && cloud.account
            ? {
                organizations: cloud.account.organizations.filter((o) => o.canEdit),
                connected:
                  cloud.state?.bindings
                    .filter((b) => b.projectId === project.id)
                    .map((b) => b.designId) ?? [],
                statuses: Object.fromEntries(
                  (cloud.state?.bindings ?? [])
                    .filter((b) => b.projectId === project.id)
                    .map((b) => [
                      b.designId,
                      b.status === "synced"
                        ? "Synced"
                        : b.status === "syncing"
                          ? "Syncing…"
                          : b.status === "offline"
                            ? "Saved locally"
                            : "Sync needs attention",
                    ]),
                ),
                publish: (designId, organizationId) =>
                  api.cloud!.connectLocal(project.id, designId, organizationId),
              }
            : undefined
        }
        onNavigate={backToFiles}
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
  }, [
    api,
    designSnapshot,
    designNavigation,
    updateLocalDesign,
    location,
    cloud.account,
    cloud.state,
    filesActive,
    backToFiles,
  ]);

  const canvasFocused = mode === "design" && (location === "cloud" ? cloudCanvas : Boolean(design));

  return (
    <DesktopShell canvasFocused={!settingsOpen && canvasFocused} settingsOpen={settingsOpen}>
      <aside
        id="desktop-navigation"
        className="desktop-navigation"
        aria-label="Project workspace"
        hidden={settingsOpen}
      >
        <header className="workspace-header">
          <div className="project-picker" title={project?.name}>
            {(project || cloud.account) && (
              <SelectMenu
                value={
                  target?.kind === "cloud" ? `cloud:${target.organizationId}` : (project?.id ?? "")
                }
                options={[
                  ...(target?.kind === "cloud" && !cloudOrganizationId
                    ? [
                        {
                          value: `cloud:${target.organizationId}`,
                          label: cloud.error ? "Workspace unavailable" : "Opening workspace…",
                        },
                      ]
                    : []),
                  ...(cloud.account?.organizations
                    .filter((o) => o.canEdit)
                    .map((o) => ({
                      value: `cloud:${o.id}`,
                      label: o.name,
                      description: "Cloud workspace",
                    })) ?? []),
                  ...projects.map((item) => ({
                    value: item.id,
                    label: item.name,
                    description: "On this computer",
                  })),
                  { value: "open", label: "Open project…" },
                ]}
                label="Workspace"
                disabled={opening}
                onChange={(value) => {
                  if (value.startsWith("cloud:")) selectCloudWorkspace(value.slice(6));
                  else void chooseProject(value === "open" ? undefined : value);
                }}
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
                {location === "cloud" && item.id === "code" ? "Threads" : item.label}
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
          </>
        )}
        <nav
          ref={setDesignNavigation}
          className="design-navigation"
          aria-label="Design folders"
          hidden={mode !== "design"}
        />
        <div className="sidebar-footer">
          <Button
            ref={settingsTrigger}
            className="settings-trigger"
            aria-label="Settings"
            title="Settings"
            onClick={() => {
              navigation.current++;
              setOpening(false);
              setSettingsOpen(true);
            }}
          >
            <Icon name="settings" size={18} />
          </Button>
          <AppUpdate api={api} />
        </div>
      </aside>
      <main className="workspace" hidden={settingsOpen}>
        {location === "cloud" && !cloudOrganizationId && (
          <div className="cloud-unavailable">
            <p role={cloud.error ? "alert" : "status"}>{cloud.error || "Opening workspace…"}</p>
            {cloud.error && (
              <Button className="quiet-button" onClick={cloud.retry}>
                Try again
              </Button>
            )}
          </div>
        )}
        {api && cloud.state?.signedIn && cloudOrganizationId && (
          <div className="workspace-view" hidden={location !== "cloud" || mode !== "design"}>
            <CloudWorkspace
              key={`${cloud.account?.id}:${cloudOrganizationId}`}
              api={api}
              cloud={cloudLibrary}
              organizationId={cloudOrganizationId}
              navigationTarget={location === "cloud" && mode === "design" ? designNavigation : null}
              active={!settingsOpen && location === "cloud" && mode === "design"}
              onCanvasChange={setCloudCanvas}
              onCatalogChange={rememberCloudCatalog}
            />
          </div>
        )}
        <div className="workspace-view" hidden={location === "cloud" && mode !== "code"}>
          {!project && location === "cloud" ? (
            <div className="cloud-unavailable">
              <p role={cloudWorkspaceError ? "alert" : "status"}>
                {cloudWorkspaceError || "Opening threads…"}
              </p>
              {cloudWorkspaceError && (
                <Button
                  className="quiet-button"
                  onClick={() => setWorkspaceRetry((value) => value + 1)}
                >
                  Try again
                </Button>
              )}
            </div>
          ) : !project ? (
            <div className="project-home">
              <h1>Tidy</h1>
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
                hidden={mode !== "design" || location === "cloud"}
                className="project-workspace canvas-open"
              >
                <div className="design-workspace">
                  {design && (
                    <LocalCanvas
                      key={design.id}
                      api={api!}
                      projectId={project.id}
                      initial={design}
                      active={!settingsOpen && location === "local" && mode === "design"}
                      onBack={backToFiles}
                      onUpdate={updateLocalDesign}
                      status={
                        <SyncStatus
                          api={api?.cloud}
                          state={cloud.state}
                          projectId={project.id}
                          designId={design.id}
                          onKeepBoth={async () => {
                            const binding = cloud.state?.bindings.find(
                              (b) => b.projectId === project.id && b.designId === design.id,
                            );
                            if (!api?.cloud || !binding?.organizationId)
                              throw new Error("Reconnect this design to resolve its conflict.");
                            const value = await api.cloud.keepBoth(
                              binding.organizationId,
                              project.id,
                              design.id,
                            );
                            updateLocalDesign(value.design);
                            setSelectedDesigns((current) => ({
                              ...current,
                              [project.id]: value.design.id,
                            }));
                          }}
                        />
                      }
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
                  <div className={`thread-heading${thread ? " thread-heading-active" : ""}`}>
                    <div className="content-heading">
                      <h1>
                        {thread?.title ?? (selectedThreadId ? "Opening thread…" : "New thread")}
                      </h1>
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
                    {thread && (
                      <div className="thread-context">
                        <ComposerContext
                          repository={repository}
                          execution={executionContext}
                          designs={snapshot.designs}
                          selected={thread.designIds}
                          onBranchChange={(branch) => void switchBranch(branch)}
                          disabled={running}
                          branchDisabled={snapshot.threads.some(
                            (item) => item.status === "running",
                          )}
                          pending={Boolean(switchingBranch)}
                        />
                      </div>
                    )}
                  </div>
                  <Conversation
                    key={`${project.id}:${selectedThreadId ?? "draft"}`}
                    identity={`${project.id}:${selectedThreadId ?? "draft"}`}
                    thread={thread}
                    active={!settingsOpen && mode === "code"}
                    api={api!}
                  />
                  {thread && api && (
                    <ThreadDesignDock
                      key={`canvases:${project.id}:${thread.id}`}
                      api={api}
                      thread={thread}
                      designs={snapshot.designs}
                      active={!settingsOpen && mode === "code"}
                      home={canvasDockHome}
                      onUpdate={updateLocalDesign}
                    />
                  )}
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
                  {thread && (
                    <MessageQueue
                      key={`queue:${thread.id}`}
                      messages={queue.messages}
                      running={running}
                      error={thread.queueError}
                      onChange={queue.change}
                      onRecover={queue.recover}
                    />
                  )}
                  <form
                    className={`composer ${thread ? "composer-active" : "composer-new"}`}
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
                    <div
                      className="composer-lip"
                      aria-hidden={Boolean(thread)}
                      inert={Boolean(thread)}
                    >
                      <ComposerContext
                        repository={repository}
                        execution={executionContext}
                        designs={
                          location === "cloud"
                            ? (cloudCatalogs[cloudKey]?.files ?? [])
                            : snapshot.designs
                        }
                        selected={
                          location === "cloud" ? (draft.cloudFileIds ?? []) : draft.designIds
                        }
                        onReferencesChange={
                          location === "cloud"
                            ? changeCloudReferences
                            : (designIds) => updateDraft({ designIds })
                        }
                        onBranchChange={(branch) => void switchBranch(branch)}
                        disabled={Boolean(thread) || busy || opening}
                        branchDisabled={snapshot.threads.some((item) => item.status === "running")}
                        pending={Boolean(switchingBranch)}
                      />
                    </div>
                    <div className="composer-body">
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
                      {!thread && !referencesReady && (
                        <span className="attachment-progress" role="status">
                          Preparing design references…
                        </span>
                      )}
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
                      <SkillPrompt
                        key={draftKey + selectedHarness}
                        skills={availableSkills}
                        status={skillCatalog.key === detailKey ? skillCatalog.status : "loading"}
                        retry={() => {
                          void loadSkills(true);
                        }}
                        id="thread-prompt"
                        value={draft.text}
                        onChange={(text) => {
                          const name = skillCommand(text)?.name;
                          const skill = availableSkills.find((skill) => skill.name === name);
                          updateDraft({
                            text,
                            skill: skill
                              ? { id: skill.id, name: skill.name, harness: selectedHarness }
                              : draft.skill?.name === name
                                ? draft.skill
                                : undefined,
                          });
                        }}
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
                            : running
                              ? "Queue a follow-up…"
                              : thread
                                ? "Continue this thread… / for skills"
                                : "What would you like to work on? / for skills"
                        }
                        disabled={Boolean(thread?.doneAt) || busy}
                        maxLength={32_000}
                        rows={2}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            event.shiftKey &&
                            (event.metaKey || event.ctrlKey) &&
                            running &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            const first = queue.messages[0];
                            if (first && !event.repeat)
                              queue.change({ kind: "steer", messageId: first.id });
                            return;
                          }
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.altKey &&
                            !event.nativeEvent.isComposing &&
                            event.nativeEvent.keyCode !== 229
                          ) {
                            event.preventDefault();
                            if (!event.repeat)
                              void send(event.metaKey || event.ctrlKey ? "steer" : "queue");
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
                        <div className="composer-settings">
                          <HarnessControls
                            catalogs={harnesses.map((connection) => ({
                              connection,
                              ...harnessDetails[`${executionProject?.id}:${connection.id}`],
                              details:
                                harnessDetails[`${executionProject?.id}:${connection.id}`]?.info,
                              loading: Boolean(
                                harnessDetails[`${executionProject?.id}:${connection.id}`]?.loading,
                              ),
                            }))}
                            onModelChange={({ harness, settings: selection }) => {
                              if (!thread)
                                updateDraft({
                                  harness,
                                  settings: {
                                    ...(harness === selectedHarness ? draft.settings : {}),
                                    ...selection,
                                  },
                                });
                              else void changeSettings({ ...thread.settings, ...selection });
                            }}
                            harness={selectedHarness}
                            settings={thread?.settings ?? draft.settings ?? {}}
                            actualModel={thread?.actualModel}
                            disabled={Boolean(
                              running ||
                              busy ||
                              (thread && settingsPending[thread.id]) ||
                              thread?.doneAt,
                            )}
                            onHarnessChange={
                              thread
                                ? undefined
                                : (harness) => updateDraft({ harness, settings: {} })
                            }
                            onSettingsChange={(settings) => void changeSettings(settings)}
                            onRefresh={() => {
                              if (executionProject && harnessReady)
                                void loadHarnessDetails(
                                  executionProject!.id,
                                  selectedHarness,
                                  true,
                                );
                            }}
                          />
                        </div>
                        <div className="composer-tools">
                          <span ref={canvasDockHome} className="canvas-dock-home" />
                          <div className="composer-delivery">
                            {running && !hasMessage ? (
                              <Button
                                type="button"
                                className="composer-submit composer-stop"
                                aria-label={
                                  queue.stopping || thread?.activity === "Stopping"
                                    ? "Stopping…"
                                    : "Stop"
                                }
                                title={
                                  queue.stopping || thread?.activity === "Stopping"
                                    ? "Stopping…"
                                    : "Stop"
                                }
                                disabled={queue.stopping || thread?.activity === "Stopping"}
                                onClick={() => queue.stop()}
                              >
                                <MessageActionIcon action="stop" />
                              </Button>
                            ) : (
                              <Button
                                type="submit"
                                className="composer-submit"
                                disabled={!canSend}
                                aria-label={submitLabel}
                                title={`${submitLabel} (Enter)`}
                              >
                                {busy ? (
                                  <Icon name="more" size={16} />
                                ) : (
                                  <MessageActionIcon
                                    action={running || queue.messages.length ? "queue" : "send"}
                                  />
                                )}
                              </Button>
                            )}
                          </div>
                        </div>
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
                    </div>
                  </form>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
      {settingsOpen && <Settings cloud={cloud} onBack={() => setSettingsOpen(false)} />}
    </DesktopShell>
  );
}
