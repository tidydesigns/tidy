import { promptThreadTitle } from "../../../shared/models/thread-naming";
import { currentThreadNaming } from "../features/settings/thread-naming-preferences";
import { useThreadNames } from "../features/threads/use-thread-names";
import { ThreadTitle } from "../features/threads/thread-title";
import {
  browserDraftKey as draftKeyForBrowser,
  getBrowserDraft,
  reserveBrowserDraft,
  type BrowserDraftCache,
} from "../features/browser/browser-drafts";
import { HarnessFailureNotices } from "../features/threads/harness-failure-dialog";
import {
  BrowserNavigationContext,
  type BrowserNavigationRequest,
} from "../features/browser/browser-navigation";
import { BrowserWorkspace } from "../features/browser/browser-workspace";
import { BrowserGlyph } from "../features/browser/browser-controls";
import {
  codeFontClassName,
  desktopNavigationClassName,
  codeStatusClassName,
  codeSubmitClassName,
} from "../styles/code-ui";
import { z } from "zod";
import { useSessionState } from "./session-state";
import { selectionSchema } from "./navigation-state";
import { useWorkspaceNavigation } from "./use-workspace-navigation";
import { ComposerContext } from "../features/composer/composer-context";
import type {
  Draft,
  MachineContext,
  PreparedWorkspace,
} from "../features/composer/machine-context";
import { useRepositoryContext } from "../features/repository/use-repository-context";
import { SkillPrompt } from "../features/composer/skill-prompt";
import { skillCommand, type Skill } from "../../../shared/contracts/skills";
import { UserFacingError } from "@tidy/ui/errors";
import { errorText, type WorkspaceError } from "./workspace-error";
import { useWorkspaceState } from "./use-workspace-state";
import { showToast, dismissToast } from "@tidy/ui/toast";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import { preloadCanvasEditor } from "../features/designs/load-canvas-editor";
import { LocalCanvas } from "../features/designs/local-canvas";
import { DesktopShell, SidebarToggle } from "./desktop-shell";
import { Settings } from "../features/settings/settings";
import { Conversations, prepareConversation } from "../features/threads/conversations";
import { ThreadDesignDock } from "../features/designs/thread-preview/dock";
import { ThreadSidebar, type ThreadOrderControls } from "../features/threads/thread-sidebar";
import { ApprovalRequests } from "../features/threads/approval-requests";
import {
  removeAttachmentReference,
  resolveAttachmentReferences,
} from "../../../shared/models/attachment-references";
import { AttachmentList } from "../features/composer/message-attachments";
import {
  type AttachedFile,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "../../../shared/contracts/attachments";
import { ProjectSwitcher } from "../features/workspace/project-switcher";
import { ProjectFiles } from "../features/workspace/project-files";
import { HarnessUsage } from "../features/harnesses/harness-usage";
import { HarnessControls } from "../features/harnesses/harness-controls";
import { ThreadReadingContext } from "../features/threads/thread-reading";
import { ThreadCard } from "../features/threads/thread-card";
import { MessageQueue } from "../features/threads/message-queue";
import { ThreadPortsStrip } from "../features/threads/thread-ports";
import { MessageActionIcon } from "../features/threads/message-action-icon";
import { useMessageQueue } from "../features/threads/use-message-queue";
import { MAX_QUEUED_MESSAGES, type MessageDelivery } from "../../../shared/contracts/message-queue";
import { AppUpdate } from "../features/updates/app-update";
import type { CloudConnection } from "../features/cloud/use-cloud";
import { CloudWorkspace } from "../features/cloud/cloud-workspace";
import { SyncStatus } from "../features/cloud/sync-status";
import type { CloudCatalog } from "../../../shared/contracts/cloud-sync";
import type { HarnessDetails, HarnessSettings } from "../../../shared/contracts/harness-settings";
import { summarizeThread, applyProjectEvent } from "../../../shared/models/thread-updates";
import type {
  DesignSummary,
  HarnessId,
  LocalDesign,
  Thread,
  ThreadSummary,
  DesktopAPI,
} from "../../../shared/contracts/desktop";

const modes = [
  { id: "design", label: "Design" },
  { id: "code", label: "Threads" },
] as const;
type Mode = (typeof modes)[number]["id"];
const preloadConversation = () => {
  void prepareConversation().catch(() => {});
};
const modePreloaders = {
  design: preloadCanvasEditor,
  code: preloadConversation,
} satisfies Record<Mode, () => void>;
const emptyDraft: Draft = { text: "", harness: "codex", designIds: [] };

export function App({
  workspaceAPI,
  machine,
  initial,
  draftCache,
  browserDraftCache,
  cloud,
}: {
  workspaceAPI?: DesktopAPI;
  machine?: MachineContext;
  initial?: PreparedWorkspace;
  draftCache?: Map<string, Record<string, Draft>>;
  browserDraftCache?: BrowserDraftCache;
  cloud: CloudConnection;
}) {
  const api = machine ? workspaceAPI : window.tidy;
  const cloudLibrary = useMemo(
    () => ({ state: cloud.state, account: cloud.account }),
    [cloud.state, cloud.account],
  );
  const [settingsPage, setSettingsPage] = useState<"account" | "remote">("account");
  const [settingsOpen, setSettingsOpen] = useSessionState("settings", z.boolean(), false);
  const [settingsVisited, setSettingsVisited] = useState(settingsOpen);
  if (settingsOpen && !settingsVisited) setSettingsVisited(true);
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
  const [threadQueries, setThreadQueries] = useState<Record<string, string>>({});
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserRequest, setBrowserRequest] = useState<BrowserNavigationRequest>();
  const [mode, setMode] = useSessionState<Mode>("mode", z.enum(["design", "code"]), "design");
  const [designNavigation, setDesignNavigation] = useState<HTMLElement | null>(null);
  const [opening, setOpening] = useState(false);
  const projectFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (opening) return;
    const previous = projectFocus.current;
    projectFocus.current = null;
    if (previous?.isConnected && document.activeElement === document.body) previous.focus();
  }, [opening]);
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
  const [selectedThreads, setSelectedThreads] = useSessionState("threads", selectionSchema, {});
  const [selectedDesigns, setSelectedDesigns] = useSessionState("designs", selectionSchema, {});
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => ({
    ...draftCache?.get(machine?.current.id ?? "local"),
    ...(initial?.draft && initial.bootstrap.activeProject
      ? { [`${initial.bootstrap.activeProject.project.id}:new`]: initial.draft }
      : {}),
  }));
  useLayoutEffect(() => {
    if (machine) draftCache?.set(machine.current.id, drafts);
  }, [drafts, machine?.current.id, draftCache]);
  useLayoutEffect(() => {
    const project = initial?.bootstrap.activeProject?.project;
    if (!initial?.draft || !project) return;
    setSelectedThreads((current) => ({ ...current, [project.id]: null }));
    setMode("code");
    selectLocalWorkspace();
    document.getElementById("thread-prompt")?.focus();
  }, []);
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
  const [error, setError] = useState<WorkspaceError | null>(null);
  const {
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
  } = useWorkspaceState({
    api,
    navigation,
    onError: setError,
    initial: initial?.bootstrap,
    initialThreads: initial?.threads,
    connection: machine ? (machine.connected ? "connected" : "offline") : undefined,
  });
  const receiveNamedThread = useCallback(
    (value: Thread) => {
      setThreads((current) =>
        current[value.id] && current[value.id].revision > value.revision
          ? current
          : { ...current, [value.id]: value },
      );
      setSnapshots((current) => {
        const snapshot = current[value.projectId];
        return snapshot
          ? {
              ...current,
              [value.projectId]: applyProjectEvent(snapshot, { type: "thread", thread: value }),
            }
          : current;
      });
    },
    [setThreads, setSnapshots],
  );
  const {
    overrides: threadNameOverrides,
    generating: generatingNames,
    rename: renameThread,
    regenerate: regenerateThreadName,
  } = useThreadNames(api, receiveNamedThread);
  const [editingThreadName, setEditingThreadName] = useState<string>();
  const threadSelection = useRef<Record<string, number>>({});
  const referenceSelections = useRef(new Map<string, number>());
  const workspaceProjectId = location === "cloud" ? cloudProjects[cloudKey] : activeProjectId;
  const snapshot = workspaceProjectId ? snapshots[workspaceProjectId] : undefined;
  const project = snapshot?.project;
  const deferredThreadQueries = useDeferredValue(threadQueries);
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
  const promptHistory = useMemo(
    () => thread?.messages.filter((message) => message.role === "user") ?? [],
    [thread?.messages],
  );
  const selectedSummary = snapshot?.threads.find((item) => item.id === selectedThreadId);
  const executionProjectId = selectedThreadId
    ? (thread?.executionProjectId ?? selectedSummary?.executionProjectId)
    : draft.executionProjectId;
  const executionProject = executionProjectId
    ? projects.find((item) => item.id === executionProjectId)
    : project;
  const localBrowserDrafts = useRef<BrowserDraftCache>(new Map());
  const draftBrowserIds = browserDraftCache ?? localBrowserDrafts.current;
  const browserDraftKey = draftKeyForBrowser({
    machineId: machine?.current.id ?? "local",
    projectId: project?.id ?? "",
    executionProjectId: executionProject?.id ?? "",
  });
  const browserScope = useMemo(() => {
    if (!executionProject || executionProject.cloud) return null;
    const threadId = selectedThreadId ?? getBrowserDraft(draftBrowserIds, browserDraftKey);
    return { projectId: executionProject.id, threadId };
  }, [draftBrowserIds, browserDraftKey, selectedThreadId]);
  useEffect(() => {
    setBrowserRequest((request) =>
      request &&
      (request.projectId !== browserScope?.projectId || request.threadId !== browserScope.threadId)
        ? undefined
        : request,
    );
  }, [browserScope?.projectId, browserScope?.threadId]);
  const openBrowserLink = useCallback(
    (url: string) => {
      if (!browserScope) return;
      setBrowserOpen(true);
      setBrowserRequest({ ...browserScope, id: crypto.randomUUID(), url });
    },
    [browserScope],
  );
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "KeyB" &&
        api?.browser &&
        browserScope
      ) {
        event.preventDefault();
        setBrowserOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [api, browserScope]);

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
  const hasSavedConversations = Boolean(snapshot?.threads.some((thread) => thread.messageCount));
  useEffect(() => {
    if (!snapshot) return;
    const task = window.requestIdleCallback(
      () => {
        if (mode === "code" || hasSavedConversations) preloadConversation();
        if (mode === "design" && snapshot.designs.length) preloadCanvasEditor();
      },
      { timeout: 1500 },
    );
    return () => window.cancelIdleCallback(task);
  }, [Boolean(snapshot), mode, hasSavedConversations, Boolean(snapshot?.designs.length)]);

  const recentThreadIds =
    snapshot?.threads
      .filter((item) => !item.doneAt)
      .slice(0, 3)
      .map((item) => item.id)
      .join(":") ?? "";
  useEffect(() => {
    if (!project || settingsOpen || document.hidden || !recentThreadIds) return;
    let cancelled = false;
    const task = window.requestIdleCallback(
      () => {
        void (async () => {
          for (const threadId of recentThreadIds.split(":")) {
            if (cancelled || document.hidden) return;
            await readThread({ projectId: project.id, threadId }).catch(() => {});
          }
        })();
      },
      { timeout: 1500 },
    );
    return () => {
      cancelled = true;
      window.cancelIdleCallback(task);
    };
  }, [project?.id, recentThreadIds, readThread, settingsOpen]);

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
    (!machine || (machine.connected && !machine.switching)) &&
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

  useEffect(() => {
    if (
      !api?.warmThread ||
      !project ||
      !executionProject ||
      (selectedThreadId && (!thread || thread.status === "running" || thread.doneAt)) ||
      !harnessReady ||
      mode !== "code" ||
      settingsOpen ||
      switchingBranch
    )
      return;
    let lastWarm = 0;
    const warm = () => {
      if (document.visibilityState === "hidden") return;
      lastWarm = Date.now();
      void api
        .warmThread?.({
          projectId: project.id,
          threadId: thread?.id,
          executionProjectId: project.cloud ? executionProjectId : undefined,
          harness: selectedHarness,
          settings: thread?.settings ?? draft.settings,
        })
        .catch(() => {});
    };
    const interact = (event: Event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.id === "thread-prompt" &&
        Date.now() - lastWarm >= 30_000
      )
        warm();
    };
    warm();
    window.addEventListener("focus", warm);
    document.addEventListener("input", interact);
    document.addEventListener("focusin", interact);
    return () => {
      window.removeEventListener("focus", warm);
      document.removeEventListener("input", interact);
      document.removeEventListener("focusin", interact);
    };
  }, [
    api,
    project?.id,
    executionProject?.id,
    executionProjectId,
    selectedThreadId,
    thread?.id,
    thread?.status,
    thread?.doneAt,
    thread?.settings?.model,
    thread?.settings?.effort,
    thread?.settings?.permissionMode,
    harnessReady,
    selectedHarness,
    draft.settings?.model,
    draft.settings?.effort,
    draft.settings?.permissionMode,
    mode,
    settingsOpen,
    switchingBranch,
  ]);

  async function changeSettings(settings: HarnessSettings) {
    if (!thread) {
      updateDraft({ settings });
      return;
    }
    if (!api || !project) return;
    await changeThreadConfiguration({ settings }, () =>
      api.setThreadSettings(project.id, thread.id, settings),
    );
  }

  async function changeThreadConfiguration(
    patch: Pick<Partial<Thread>, "settings" | "executionProjectId">,
    persist: () => Promise<Thread>,
  ) {
    if (!thread) return;
    if (!api || !project || running || settingsPending[thread.id]) return;
    const previous = thread,
      projectId = project.id;
    const optimistic = { ...thread, ...patch, revision: thread.revision + 1 };
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
      apply(await persist());
    } catch (cause) {
      const matches = (value: ThreadSummary) =>
        value.revision === optimistic.revision &&
        value.status === optimistic.status &&
        Object.keys(patch).every(
          (key) =>
            JSON.stringify(value[key as keyof typeof patch]) ===
            JSON.stringify(patch[key as keyof typeof patch]),
        );
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
      [draftKey]: { ...(current[draftKey] ?? draft), ...patch },
    }));
  }

  function changePrompt(text: string, attachments?: AttachedFile[]) {
    const name = skillCommand(text)?.name;
    const skill = availableSkills.find((skill) => skill.name === name);
    updateDraft({
      text,
      // Text edits can follow attachment insertion in the same event. Only recall
      // replaces files; otherwise preserve the latest draft's attachment list.
      ...(attachments === undefined ? {} : { attachments }),
      skill: skill
        ? { id: skill.id, name: skill.name, harness: selectedHarness }
        : draft.skill?.name === name
          ? draft.skill
          : undefined,
    });
  }

  const selectThread = useCallback(
    (projectId: string, threadId: string | null) => {
      threadSelection.current[projectId] = (threadSelection.current[projectId] ?? 0) + 1;
      if (threadId) void readThread({ projectId, threadId }).catch(() => {});
      setSelectedThreads((current) => ({ ...current, [projectId]: threadId }));
    },
    [readThread],
  );

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

  const selectedThreadCached = Boolean(thread);
  useEffect(() => {
    if (
      mode !== "code" ||
      settingsOpen ||
      !api ||
      !project ||
      !selectedThreadId ||
      selectedThreadCached
    )
      return;
    if (!snapshot?.threads.some((item) => item.id === selectedThreadId)) {
      selectThread(project.id, null);
      return;
    }
    let active = true;
    void readThread({ projectId: project.id, threadId: selectedThreadId }).catch((value) => {
      if (active) setError({ projectId: project.id, text: errorText(value), original: value });
    });
    return () => {
      active = false;
    };
  }, [
    api,
    project,
    selectedThreadId,
    selectedThreadCached,
    readThread,
    location,
    mode,
    settingsOpen,
  ]);

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
    if (!api) return;
    projectFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const generation = ++navigation.current;
    const cached = projectId ? snapshots[projectId] : undefined;
    setOpening(!cached);
    setError(null);
    if (cached) {
      setActiveProjectId(cached.project.id);
      selectLocalWorkspace();
    }
    const refresh = async () => {
      try {
        const value = projectId ? await api.selectProject(projectId) : await api.openProject();
        if (value && navigation.current === generation) {
          applySnapshot(value, true, cached);
          selectLocalWorkspace();
        }
      } catch (value) {
        if (navigation.current === generation)
          setError({ text: errorText(value), original: value });
      } finally {
        if (navigation.current === generation) setOpening(false);
      }
    };
    // Close the picker immediately for a cached destination; refresh only that destination.
    if (cached) void refresh();
    else await refresh();
  }

  async function chooseExecutionProject(value: string) {
    if (
      !api ||
      !project?.cloud ||
      (selectedThreadId && !thread) ||
      running ||
      opening ||
      (thread && settingsPending[thread.id])
    )
      return;
    const changeExecution = async (executionProjectId?: string) => {
      if (!thread) {
        updateDraft({ executionProjectId, skill: undefined });
        return;
      }
      if (thread.executionProjectId === executionProjectId) return;
      updateDraft({ skill: undefined });
      await changeThreadConfiguration({ executionProjectId }, () =>
        api.setThreadExecutionProject(project.id, thread.id, executionProjectId),
      );
    };
    if (value !== "open") {
      await changeExecution(value === "design" ? undefined : value);
      return;
    }
    const key = draftKey;
    const fallback = draft;
    setOpening(true);
    try {
      const opened = await api.openProject();
      if (!opened) return;
      applySnapshot(opened, false);
      if (thread) {
        await changeExecution(opened.project.id);
        return;
      }
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
          { value: "open", label: "Open project…" },
        ],
        ...(!selectedThreadId || (thread && !settingsPending[thread.id])
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

  function attachFiles(files: File[]): AttachedFile[] {
    if (!api || !project || thread?.doneAt || busy || !files.length) return [];
    const projectId = project.id,
      key = draftKey,
      fallback = draft;
    const attached = [...(draftsRef.current[key]?.attachments ?? fallback.attachments ?? [])];
    const pending: { file: File; attachment: AttachedFile }[] = [];
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
      const attachment: AttachedFile = {
        id: crypto.randomUUID(),
        name: file.name.slice(0, 200) || "Pasted image.png",
        mimeType: file.type,
        size: file.size,
        ...(image ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
      attached.push(attachment);
      pending.push({ file, attachment });
    }
    if (errors.length) setError({ projectId, text: [...new Set(errors)].join(" ") });
    if (!pending.length) return [];
    const next = { ...(draftsRef.current[key] ?? fallback), attachments: attached };
    draftsRef.current = { ...draftsRef.current, [key]: next };
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? fallback), attachments: attached },
    }));
    setUploading((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
    const queued = (uploads.current[key] ?? Promise.resolve())
      .then(async () => {
        for (const { file, attachment } of pending) {
          try {
            if (!draftsRef.current[key]?.attachments?.some((item) => item.id === attachment.id))
              continue;
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(new Error("Could not read this file."));
              reader.readAsDataURL(file);
            });
            const value = await api.addAttachment(projectId, attachment.name, dataUrl);
            setDrafts((current) => {
              const latest = current[key] ?? fallback;
              return {
                ...current,
                [key]: {
                  ...latest,
                  attachments: latest.attachments?.map((item) =>
                    item.id === attachment.id ? { ...value, referenceId: attachment.id } : item,
                  ),
                },
              };
            });
          } catch (cause) {
            setDrafts((current) => {
              const latest = current[key] ?? fallback;
              return {
                ...current,
                [key]: {
                  ...latest,
                  text: removeAttachmentReference(latest.text, attachment),
                  attachments: latest.attachments?.filter((item) => item.id !== attachment.id),
                },
              };
            });
            setError({ projectId, text: errorText(cause) });
          } finally {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
          }
        }
      })
      .finally(() => {
        setUploading((current) => ({ ...current, [key]: Math.max(0, (current[key] ?? 1) - 1) }));
      });
    uploads.current[key] = queued.catch(() => {});
    return pending.map(({ attachment }) => attachment);
  }

  async function send(delivery: MessageDelivery = "queue") {
    if (
      (machine && (!machine.connected || machine.switching)) ||
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
    const submitted = resolveAttachmentReferences(draft.text, draft.attachments ?? []);
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
          text: submitted,
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
    const id = selectedThreadId ?? browserScope?.threadId ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const pendingKey = `${projectId}:${id}`;
    const optimistic: Thread = {
      ...(thread ?? {
        id,
        projectId,
        harness: draft.harness,
        settings: draft.settings,
        executionProjectId: project.cloud ? draft.executionProjectId : undefined,
        title: promptThreadTitle(submitted),
        titleSource: "prompt",
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
          turn: { startedAt: new Date().toISOString() },
          ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
        },
      ],
      status: "running",
      activity: "Starting",
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    const restoreBrowserDraft =
      !selectedThreadId && browserScope
        ? reserveBrowserDraft(draftBrowserIds, browserDraftKey, id)
        : undefined;
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
            naming: currentThreadNaming(),
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
      if (restoreBrowserDraft?.() === false && browserScope)
        void api.browser
          ?.discardDraft({ ...browserScope, ownerProjectId: projectId })
          .catch((cause: unknown) => {
            setError({ projectId, text: errorText(cause), original: cause });
          });
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
      if (!api || !project || updatingDone[item.id]) return;
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
      setHarnessDiscoveryFailed(false);
    } catch (value) {
      setHarnessDiscoveryFailed(true);
      setError({ text: errorText(value), original: value });
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % modes.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
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

  const selectedThreadLoaded =
    thread?.status === "completed" &&
    (selectedSummary?.messageCount === undefined ||
      thread.messages.length === selectedSummary.messageCount);
  const renderThread = useCallback(
    (item: ThreadSummary, orderControls?: ThreadOrderControls) => (
      <ThreadCard
        thread={
          threadNameOverrides[item.id] ? { ...item, title: threadNameOverrides[item.id] } : item
        }
        onRenameRequested={() => setEditingThreadName(item.id)}
        orderControls={orderControls}
        selected={mode === "code" && selectedThreadId === item.id}
        loaded={selectedThreadId === item.id && selectedThreadLoaded}
        now={now}
        pending={Boolean(updatingDone[item.id] || settingsPending[item.id])}
        onPreload={() => {
          preloadConversation();
          void readThread({ projectId: item.projectId, threadId: item.id }).catch(() => {});
        }}
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
      selectedThreadLoaded,
      mode,
      now,
      updatingDone,
      settingsPending,
      selectThread,
      readThread,
      project,
      toggleThreadDone,
      harnessDetails,
      repository,
      threadNameOverrides,
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

  const failureNoticeAccessKey = useMemo(
    () =>
      JSON.stringify([
        cloud.state?.signedIn,
        cloud.state?.accountId,
        cloud.account?.id,
        cloud.account?.organizations
          .filter((organization) => organization.canEdit)
          .map((organization) => organization.id)
          .sort(),
      ]),
    [cloud.state?.signedIn, cloud.state?.accountId, cloud.account],
  );

  const canvasFocused = mode === "design" && (location === "cloud" ? cloudCanvas : Boolean(design));

  return (
    <DesktopShell canvasFocused={!settingsOpen && canvasFocused} settingsOpen={settingsOpen}>
      <HarnessFailureNotices key={failureNoticeAccessKey} api={api} />
      <aside
        id="desktop-navigation"
        className={`desktop-navigation col-start-1 row-span-full flex min-h-0 min-w-0 flex-col border-r border-border bg-(--desktop-navigation-surface) ${desktopNavigationClassName}`}
        aria-label="Project workspace"
        hidden={settingsOpen}
      >
        <header className="workspace-header flex shrink-0 flex-col gap-1.5 px-1 pt-1 pb-2">
          <div className="workspace-project-row flex items-center gap-0 pr-1">
            <SidebarToggle />
            <div className="project-picker min-w-0 w-full flex-1" title={project?.name}>
              {(project || cloud.account || machine) && (
                <ProjectSwitcher
                  machines={machine?.machines}
                  machineId={machine?.current.id}
                  projects={projects}
                  projectId={project?.id}
                  loadProjects={machine?.projects}
                  onRemove={
                    machine?.removeProject || api?.removeProject
                      ? async (machineId, projectId) => {
                          const local = !machine || machineId === machine.current.id;
                          const removed = projects.find((item) => item.id === projectId);
                          const wasActive = activeProjectId === projectId;
                          const generation = local ? ++navigation.current : navigation.current;
                          if (local) {
                            setProjects((items) => items.filter((item) => item.id !== projectId));
                            if (wasActive) setActiveProjectId(null);
                          }
                          try {
                            if (machine?.removeProject)
                              await machine.removeProject(machineId, projectId);
                            else if (api?.removeProject) await api.removeProject(projectId);
                          } catch (error) {
                            if (local && removed) {
                              setProjects((items) =>
                                items.some((item) => item.id === projectId)
                                  ? items
                                  : [...items, removed],
                              );
                              if (wasActive && generation === navigation.current)
                                setActiveProjectId(projectId);
                            }
                            if (error instanceof UserFacingError) throw error;
                            const activeWork =
                              "Wait for this project's active work to finish before removing it.";
                            throw new UserFacingError(
                              error instanceof Error && error.message.includes(activeWork)
                                ? activeWork
                                : "Could not remove this project. Reconnect the machine and try again.",
                              { cause: error },
                            );
                          }
                        }
                      : undefined
                  }
                  disabled={opening || busy || Boolean(uploading[draftKey])}
                  label={
                    target?.kind === "cloud"
                      ? (cloud.account?.organizations.find(
                          (item) => item.id === target.organizationId,
                        )?.name ?? "Cloud workspace")
                      : undefined
                  }
                  cloudId={target?.kind === "cloud" ? target.organizationId : undefined}
                  cloudWorkspaces={
                    api?.cloud
                      ? (cloud.account?.organizations ?? []).filter((item) => item.canEdit)
                      : []
                  }
                  onCloudChange={selectCloudWorkspace}
                  onCancelNavigation={() => {
                    navigation.current++;
                    setOpening(false);
                    machine?.cancelProjectNavigation();
                  }}
                  onChoose={async (machineId, projectId) => {
                    navigation.current++;
                    machine?.cancelProjectNavigation();
                    if (!machine || machineId === machine.current.id)
                      await chooseProject(projectId);
                    else await machine.openProject(machineId, projectId);
                  }}
                  onAddMachine={
                    window.tidyMachines && window.tidyRemote
                      ? () => {
                          setSettingsPage("remote");
                          setSettingsOpen(true);
                        }
                      : undefined
                  }
                />
              )}
            </div>
          </div>
          {project && (
            <div className="workspace-thread-actions flex items-center gap-1.5 px-1 py-0.5">
              <label className="workspace-thread-search flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-panel px-2 text-muted-ink focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-control-border [&>svg]:shrink-0">
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <circle cx="8.5" cy="8.5" r="5.5" />
                  <path d="m13 13 4 4" />
                </svg>
                <input
                  type="search"
                  className="w-full min-w-0 border-0 bg-transparent p-0 text-xs leading-5 text-ink outline-none placeholder:text-muted-ink focus-visible:outline-none"
                  aria-label="Search threads"
                  placeholder="Search threads"
                  value={threadQueries[project.id] ?? ""}
                  onChange={(event) => {
                    const query = event.currentTarget.value;
                    setThreadQueries((current) => ({ ...current, [project.id]: query }));
                    setMode("code");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    setThreadQueries((current) => ({ ...current, [project.id]: "" }));
                  }}
                />
              </label>
              <Button
                className="sidebar-new-thread active:scale-[0.97] grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border border-transparent bg-transparent p-0 text-muted-ink hover:bg-hover-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
                aria-label="New thread"
                title="New thread"
                onClick={() => {
                  setThreadQueries((current) => ({ ...current, [project.id]: "" }));
                  setMode("code");
                  selectThread(project.id, null);
                  requestAnimationFrame(() =>
                    document.querySelector<HTMLElement>("#thread-prompt")?.focus(),
                  );
                }}
              >
                <svg
                  aria-hidden="true"
                  width="17"
                  height="17"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-4" />
                  <path d="m9 11 1-4 6-6 3 3-6 6-4 1Zm6-9 3 3" />
                </svg>
              </Button>
            </div>
          )}
          <div
            role="tablist"
            aria-label="Workspace"
            aria-orientation="vertical"
            className="workspace-tabs flex w-full flex-col gap-1 px-1"
          >
            {modes.map((item, index) => (
              <div className="workspace-destination flex items-center rounded-md" key={item.id}>
                <Button
                  id={`workspace-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={mode === item.id}
                  aria-controls={`workspace-panel-${item.id}`}
                  tabIndex={mode === item.id ? 0 : -1}
                  className="workspace-tab flex min-w-0 flex-auto cursor-pointer items-center justify-start gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-[7px] text-sm leading-5 font-medium whitespace-nowrap text-muted-ink hover:bg-hover-surface hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
                  onPointerEnter={modePreloaders[item.id]}
                  onFocus={modePreloaders[item.id]}
                  onClick={() => setMode(item.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {item.id === "design" ? (
                    <Icon name="frame" size={14} />
                  ) : (
                    <svg
                      className="code-mode-icon shrink-0"
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
              </div>
            ))}
          </div>
        </header>
        {project && snapshot && (
          <>
            <div
              className="sidebar-mode-content flex min-h-0 flex-1 [&[hidden]]:hidden"
              hidden={mode !== "code"}
            >
              <ThreadReadingContext value={!settingsOpen && mode === "code"}>
                <ThreadSidebar
                  key={project.id}
                  projectId={project.id}
                  threads={snapshot.threads}
                  search={deferredThreadQueries[project.id] ?? ""}
                  renderThread={renderThread}
                />
              </ThreadReadingContext>
            </div>
          </>
        )}
        <nav
          ref={setDesignNavigation}
          className="design-navigation"
          aria-label="Design folders"
          hidden={mode !== "design"}
        />
        <div className="sidebar-footer mt-auto flex shrink-0 items-center gap-2 p-2">
          <Button
            ref={settingsTrigger}
            className="settings-trigger"
            aria-label="Settings"
            title="Settings"
            onClick={() => {
              navigation.current++;
              setOpening(false);
              setSettingsPage("account");
              setSettingsOpen(true);
            }}
          >
            <Icon name="settings" size={18} />
          </Button>
          {api && executionProject && (
            <HarnessUsage
              key={`${executionProject.id}:${selectedHarness}`}
              api={api}
              projectId={executionProject.id}
              harness={selectedHarness}
              ready={harnessReady}
              initial={harnessDetails[detailKey]?.info?.usage}
              tokens={thread?.usage}
              activity={thread?.status}
              modelId={
                (thread ? (thread.settings?.model ?? thread.actualModel) : draft.settings?.model) ??
                harnessDetails[detailKey]?.info?.defaultModel
              }
            />
          )}
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
                className="project-workspace bg-panel"
              >
                <div
                  className={`thread-workspace relative flex min-h-0 min-w-0 flex-col ${codeStatusClassName}`}
                  data-new-thread={!selectedThreadId || undefined}
                >
                  <div
                    className={`thread-heading ${codeFontClassName} flex min-h-[42px] shrink-0 items-center gap-6 px-5 py-1 ${thread ? "thread-heading-active max-[700px]:flex-wrap max-[700px]:gap-1 max-[700px]:pb-2" : ""}`}
                  >
                    <div
                      className={`content-heading flex min-h-[34px] min-w-0 flex-1 items-center justify-between gap-4 ${thread ? "max-[700px]:basis-full" : ""}`}
                    >
                      {thread || selectedSummary ? (
                        <ThreadTitle
                          key={`${project.id}:${selectedThreadId}`}
                          thread={{
                            ...(thread ?? selectedSummary!),
                            title:
                              threadNameOverrides[selectedThreadId!] ??
                              thread?.title ??
                              selectedSummary!.title,
                          }}
                          generating={Boolean(generatingNames[selectedThreadId!])}
                          editRequested={editingThreadName === selectedThreadId}
                          onEditFinished={() => setEditingThreadName(undefined)}
                          onRename={renameThread}
                          onRegenerate={regenerateThreadName}
                        />
                      ) : (
                        <h1 className="m-0 truncate text-sm leading-[1.5] font-medium">
                          New thread
                        </h1>
                      )}
                      {thread?.doneAt && (
                        <Button
                          className="quiet-button thread-heading-action shrink-0"
                          disabled={running || Boolean(updatingDone[thread.id])}
                          onClick={() => void toggleThreadDone(summarizeThread(thread))}
                        >
                          Reopen thread
                        </Button>
                      )}
                    </div>
                    {!browserOpen && api?.browser && browserScope && (
                      <Button
                        type="button"
                        className="quiet-button browser-toggle-button"
                        aria-label="Open browser"
                        aria-expanded={browserOpen}
                        title="Browser (⌘/Ctrl+Shift+B)"
                        onClick={() => setBrowserOpen(true)}
                      >
                        <BrowserGlyph />
                      </Button>
                    )}
                    {thread && (
                      <div className="thread-context min-w-0 max-w-[390px] shrink-0 max-[700px]:ml-auto max-[700px]:max-w-full [&_.composer-context]:justify-end [&_.composer-context]:gap-4 [&_.thread-references]:m-0 [&_.thread-references]:whitespace-nowrap [&_.context-machine]:m-0 [&_.context-machine>span]:max-w-[100px] [&_.branch-trigger]:max-w-[150px]">
                        <ComposerContext
                          repository={repository}
                          machine={machine ? { label: machine.current.label } : undefined}
                          execution={executionContext}
                          designs={snapshot.designs}
                          selected={thread.designIds}
                          onBranchChange={(branch) => void switchBranch(branch)}
                          disabled={running || busy || opening}
                          pending={Boolean(switchingBranch)}
                        />
                      </div>
                    )}
                  </div>
                  <BrowserNavigationContext value={openBrowserLink}>
                    <Conversations
                      key={failureNoticeAccessKey}
                      projectId={project.id}
                      selected={selectedThreadId ?? null}
                      threads={threads}
                      active={!settingsOpen && mode === "code"}
                      api={api!}
                    />
                  </BrowserNavigationContext>
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
                    className={`composer relative isolate mx-auto mb-6 w-[calc(100%_-_var(--chat-gutter)_*_2)] max-w-(--chat-content-width) shrink-0 rounded-2xl border-0 bg-transparent p-0 ${codeFontClassName} ${thread ? "composer-active mt-3" : "composer-new mt-[58px]"}`}
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
                      className={`composer-lip absolute right-3 bottom-[calc(100%_-_20px)] left-3 rounded-t-2xl border border-border bg-[light-dark(#f5f5f5,#222222)] px-2 py-[7px] pb-[25px] max-[700px]:right-2 max-[700px]:left-2 max-[700px]:px-1.5 ${thread ? "invisible pointer-events-none opacity-0" : ""}`}
                      aria-hidden={Boolean(thread)}
                      inert={Boolean(thread)}
                    >
                      <ComposerContext
                        repository={repository}
                        machine={
                          machine
                            ? {
                                label: machine.current.label,
                                value: machine.current.id,
                                options: machine.machines,
                                onChange: (id) => {
                                  if (!project || !executionProject) return;
                                  machine.select(id, {
                                    project: executionProject,
                                    contextProjectId: project.id,
                                    draft: { ...draft, designIds: referenceDesignIds },
                                  });
                                },
                              }
                            : undefined
                        }
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
                        disabled={
                          Boolean(thread) ||
                          busy ||
                          opening ||
                          Boolean(uploading[draftKey]) ||
                          machine?.switching === true
                        }
                        pending={Boolean(switchingBranch)}
                      />
                    </div>
                    {thread && api && (
                      <ThreadPortsStrip
                        key={`${project.id}:${thread.id}`}
                        api={api}
                        projectId={project.id}
                        threadId={thread.id}
                        active={!settingsOpen && mode === "code"}
                        connected={machine?.connected ?? true}
                        openBrowser={openBrowserLink}
                        remoteLabel={
                          machine && machine.current.id !== "local"
                            ? machine.current.label
                            : undefined
                        }
                      />
                    )}
                    <div className="composer-body relative z-[1] rounded-2xl border border-border bg-(--desktop-composer-surface) p-3 max-[700px]:p-2.5 focus-within:border-control-border">
                      {machine && !machine.connected && (
                        <p
                          role="status"
                          className="mx-2.5 mt-1 mb-2 text-xs leading-5 text-muted-ink"
                        >
                          {machine.current.label} is{" "}
                          {machine.current.status?.kind === "reconnecting"
                            ? "reconnecting"
                            : "offline"}
                          . Your draft is kept here.
                        </p>
                      )}
                      <AttachmentList
                        files={draft.attachments ?? []}
                        onRemove={
                          thread?.doneAt
                            ? undefined
                            : (id) => {
                                const file = draft.attachments?.find((item) => item.id === id);
                                updateDraft({
                                  text: file
                                    ? removeAttachmentReference(draft.text, file)
                                    : draft.text,
                                  attachments: draft.attachments?.filter((item) => item.id !== id),
                                });
                              }
                        }
                      />
                      {!thread && !referencesReady && (
                        <span
                          className="attachment-progress block px-2 pt-0.5 pb-2 text-[11px] text-muted-ink"
                          role="status"
                        >
                          Preparing design references…
                        </span>
                      )}
                      {Boolean(uploading[draftKey]) && (
                        <span
                          className="attachment-progress block px-2 pt-0.5 pb-2 text-[11px] text-muted-ink"
                          role="status"
                        >
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
                      <SkillPrompt
                        className="block w-full resize-none overflow-y-auto rounded border-0 bg-transparent px-1.5 py-2 text-sm leading-6 text-ink [field-sizing:content] min-h-[calc(1lh_+_16px)] max-h-[min(200px,40dvh)] placeholder:text-muted-ink focus:outline-none"
                        key={draftKey + selectedHarness}
                        skills={availableSkills}
                        status={skillCatalog.key === detailKey ? skillCatalog.status : "loading"}
                        retry={() => {
                          void loadSkills(true);
                        }}
                        id="thread-prompt"
                        aria-label="Message"
                        value={draft.text}
                        onChange={(text) => changePrompt(text)}
                        history={promptHistory}
                        onRecall={(entry) => changePrompt(entry.text, entry.attachments ?? [])}
                        files={draft.attachments ?? []}
                        onAttachFiles={attachFiles}
                        placeholder={
                          thread?.doneAt
                            ? "Reopen this thread to continue…"
                            : running
                              ? "Queue a follow-up…"
                              : thread
                                ? "Reply… / for skills"
                                : "Start a task… / for skills"
                        }
                        disabled={Boolean(thread?.doneAt) || busy}
                        maxLength={32_000}
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
                      <div className="composer-actions flex flex-wrap items-center gap-2 py-2">
                        <Button
                          type="button"
                          className="flex size-8 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-1.5 text-xs text-muted-ink hover:bg-hover-surface"
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
                        <div className="composer-settings contents">
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
                        <div className="composer-tools ml-auto flex shrink-0 items-center gap-3">
                          <span ref={canvasDockHome} className="canvas-dock-home" />
                          <div className="composer-delivery ml-auto flex shrink-0 items-center gap-1.5">
                            {running && !hasMessage ? (
                              <Button
                                type="button"
                                className={`${codeSubmitClassName} composer-stop bg-[#e83545] text-white`}
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
                                className={`${codeSubmitClassName} bg-strong-action text-on-strong-action`}
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
                      {!harnessReady && (harnesses.length > 0 || harnessDiscoveryFailed) && (
                        <div className="connection-help">
                          {harnesses.length > 0 ? (
                            <span>
                              {harnesses.find((item) => item.id === selectedHarness)?.name ??
                                "Your harness"}{" "}
                              needs to be installed and signed in on{" "}
                              {machine?.current.label ?? "this machine"}. Run{" "}
                              <code>
                                {selectedHarness === "codex"
                                  ? "codex login"
                                  : selectedHarness === "claude"
                                    ? "claude auth login"
                                    : "opencode auth login"}
                              </code>{" "}
                              in your terminal.
                            </span>
                          ) : (
                            <span>Could not check agent connections.</span>
                          )}
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
                  {/* Mount after the composer so its dock target ref is attached first. */}
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
                </div>
                {api?.browser && browserScope && (
                  <BrowserWorkspace
                    key={`${browserScope.projectId}:${browserScope.threadId}`}
                    api={api.browser}
                    requestedURL={browserRequest}
                    scope={browserScope}
                    open={browserOpen}
                    active={!settingsOpen && mode === "code"}
                    connected={!machine || machine.connected}
                    machineLabel={machine?.current.label ?? "This machine"}
                    onClose={() => {
                      setBrowserOpen(false);
                      setBrowserRequest(undefined);
                    }}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </main>
      {settingsVisited && (
        <Settings
          active={settingsOpen}
          initialPage={settingsPage}
          cloud={cloud}
          onBack={() => setSettingsOpen(false)}
        />
      )}
    </DesktopShell>
  );
}
