import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { TidyLogo } from "@tidy/ui/tidy-logo";
import { LocalCanvas } from "./local-canvas";
import { relativeThreadTime } from "../../shared/thread-time";
import { summarizeThread } from "../../shared/contracts";
import type {
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
type Draft = { text: string; harness: HarnessId; designIds: string[] };
const emptyDraft: Draft = { text: "", harness: "codex", designIds: [] };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The operation could not be completed.";

export function App() {
  const api = window.tidy;
  const [mode, setMode] = useState<Mode>("design");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({});
  const [harnesses, setHarnesses] = useState<HarnessConnection[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [selectedThreads, setSelectedThreads] = useState<Record<string, string | null>>({});
  const [selectedDesigns, setSelectedDesigns] = useState<Record<string, string | null>>({});
  const [designs, setDesigns] = useState<Record<string, LocalDesign>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [now, setNow] = useState(Date.now);
  const [updatingDone, setUpdatingDone] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<{ projectId?: string; text: string } | null>(null);
  const navigation = useRef(0);
  const threadSelection = useRef<Record<string, number>>({});
  const transcript = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const snapshot = activeProjectId ? snapshots[activeProjectId] : undefined;
  const project = snapshot?.project;
  const selectedThreadId = project ? selectedThreads[project.id] : null;
  const thread = selectedThreadId ? threads[selectedThreadId] : undefined;
  const draftKey = `${project?.id ?? ""}:${selectedThreadId ?? "new"}`;
  const readyHarness = harnesses.find((item) => item.status === "ready")?.id ?? "codex";
  const draft = drafts[draftKey] ?? { ...emptyDraft, harness: readyHarness };
  const selectedDesignId = project ? selectedDesigns[project.id] : null;
  const design =
    selectedDesignId && snapshot?.designs.some((item) => item.id === selectedDesignId)
      ? designs[selectedDesignId]
      : undefined;
  const running = thread?.status === "running";
  const busy = Boolean(sending[draftKey]);

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
    setDrafts((current) => ({ ...current, [draftKey]: { ...draft, ...patch } }));
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
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "thread") {
        const value = event.thread;
        setThreads((current) => ({
          ...current,
          [value.id]:
            (current[value.id]?.revision ?? -1) > value.revision ? current[value.id] : value,
        }));
        setSnapshots((current) => {
          const entry = current[value.projectId];
          if (!entry) return current;
          const summary = summarizeThread(value);
          return {
            ...current,
            [value.projectId]: {
              ...entry,
              threads: [summary, ...entry.threads.filter((item) => item.id !== value.id)].sort(
                (a, b) => b.updatedAt.localeCompare(a.updatedAt),
              ),
            },
          };
        });
      } else {
        setSnapshots((current) => {
          const entry = current[event.projectId];
          return entry
            ? { ...current, [event.projectId]: { ...entry, designs: event.designs } }
            : current;
        });
      }
    });
    void api
      .bootstrap()
      .then((value) => {
        if (!mounted) return;
        setProjects(value.projects);
        setHarnesses(value.harnesses);
        if (value.activeProject) {
          setSnapshots({ [value.activeProject.project.id]: value.activeProject });
          setActiveProjectId(value.activeProject.project.id);
        }
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
          setThreads((current) => ({ ...current, [value.id]: current[value.id] ?? value }));
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

  useEffect(() => {
    followOutput.current = true;
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [selectedThreadId, activeProjectId]);
  useEffect(() => {
    if (followOutput.current)
      transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [thread?.messages, thread?.activity]);

  async function chooseProject(projectId?: string) {
    if (!api || opening) return;
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

  async function createDesign(importing = false) {
    if (!api || !project) return;
    const projectId = project.id;
    try {
      const value = importing
        ? await api.importDesign(projectId)
        : await api.createDesign(projectId);
      if (!value) return;
      setDesigns((current) => ({ ...current, [value.id]: value }));
      setSelectedDesigns((current) => ({ ...current, [projectId]: value.id }));
    } catch (value) {
      setError({ projectId, text: errorText(value) });
    }
  }

  async function send() {
    if (!api || !project || !draft.text.trim() || busy || running || thread?.doneAt) return;
    const projectId = project.id;
    const key = draftKey;
    const submitted = draft.text;
    const selection = threadSelection.current[projectId] ?? 0;
    setSending((current) => ({ ...current, [key]: true }));
    setDrafts((current) => ({ ...current, [key]: { ...draft, text: "" } }));
    setError(null);
    try {
      const value = selectedThreadId
        ? await api.sendMessage({ projectId, threadId: selectedThreadId, text: submitted })
        : await api.startThread({
            projectId,
            harness: draft.harness,
            prompt: submitted,
            designIds: draft.designIds,
          });
      setThreads((current) => ({
        ...current,
        [value.id]:
          (current[value.id]?.revision ?? -1) > value.revision ? current[value.id] : value,
      }));
      if ((threadSelection.current[projectId] ?? 0) === selection)
        setSelectedThreads((current) => ({ ...current, [projectId]: value.id }));
      followOutput.current = true;
    } catch (value) {
      setDrafts((current) => ({
        ...current,
        [key]: current[key]?.text ? current[key] : { ...draft, text: submitted },
      }));
      setError({ projectId, text: errorText(value) });
    } finally {
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
              [summary.id]: { ...value, doneAt: summary.doneAt, revision: summary.revision },
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
          ? { ...current, [item.id]: { ...value, doneAt: item.doneAt, revision: item.revision } }
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

  const activeThreads = snapshot?.threads.filter((item) => !item.doneAt) ?? [];
  const doneThreads = (snapshot?.threads.filter((item) => item.doneAt) ?? []).sort((a, b) =>
    b.doneAt!.localeCompare(a.doneAt!),
  );
  const renderThread = (item: ThreadSummary) => (
    <ThreadCard
      key={item.id}
      thread={item}
      selected={selectedThreadId === item.id}
      now={now}
      pending={Boolean(updatingDone[item.id])}
      onSelect={() => selectThread(project!.id, item.id)}
      onDone={() => void toggleThreadDone(item)}
    />
  );
  const visibleError = error && (!error.projectId || error.projectId === activeProjectId);
  const selectedHarness = thread?.harness ?? draft.harness;
  const harnessReady = harnesses.some(
    (item) => item.id === selectedHarness && item.status === "ready",
  );

  return (
    <div className="desktop">
      <header className="workspace-header">
        <div className="project-picker">
          {project && (
            <SelectMenu
              value={project.id}
              options={[
                ...projects.map((item) => ({ value: item.id, label: item.name })),
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
              {item.label}
            </Button>
          ))}
        </div>
        <div className="header-spacer" />
      </header>
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
              className={`project-workspace ${design ? "canvas-open" : ""}`}
            >
              <aside className="project-sidebar" hidden={Boolean(design)}>
                <div className="sidebar-heading">
                  <span>Designs</span>
                  <Button className="quiet-button" onClick={() => void createDesign()}>
                    New design
                  </Button>
                </div>
                <div className="sidebar-list">
                  {snapshot.designs.map((item) => (
                    <Button
                      key={item.id}
                      className={`sidebar-item ${selectedDesignId === item.id ? "selected" : ""}`}
                      onClick={() =>
                        setSelectedDesigns((current) => ({ ...current, [project.id]: item.id }))
                      }
                    >
                      {item.name}
                    </Button>
                  ))}
                </div>
                <Button
                  className="quiet-button sidebar-footer"
                  onClick={() => void createDesign(true)}
                >
                  Import design
                </Button>
              </aside>
              <div className="design-workspace">
                {design && (
                  <LocalCanvas
                    key={design.id}
                    api={api!}
                    projectId={project.id}
                    initial={design}
                    active={mode === "design"}
                    onBack={() =>
                      setSelectedDesigns((current) => ({ ...current, [project.id]: null }))
                    }
                    onUpdate={(value) =>
                      setDesigns((current) => ({ ...current, [value.id]: value }))
                    }
                  />
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
              <aside className="project-sidebar">
                <div className="sidebar-heading">
                  <span>Threads</span>
                  <Button className="quiet-button" onClick={() => selectThread(project.id, null)}>
                    New thread
                  </Button>
                </div>
                <div className="sidebar-list">{activeThreads.map(renderThread)}</div>
                {doneThreads.length > 0 && (
                  <details className="done-threads" key={project.id}>
                    <summary>Done ({doneThreads.length})</summary>
                    <div className="done-thread-list">{doneThreads.map(renderThread)}</div>
                  </details>
                )}
              </aside>
              <div className="thread-workspace">
                <div className="content-heading">
                  <h1>{thread?.title ?? (selectedThreadId ? "Opening thread…" : "New thread")}</h1>
                </div>
                <div
                  className="transcript"
                  ref={transcript}
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    followOutput.current =
                      element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                  }}
                >
                  {thread?.designIds.length ? (
                    <div className="thread-references">
                      {thread.designIds.map((designId) => (
                        <span key={designId} className="reference-chip">
                          {snapshot.designs.find((item) => item.id === designId)?.name ??
                            "Design reference"}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {thread?.messages.map((message) => (
                    <article key={message.id} className={`message message-${message.role}`}>
                      <span className="message-author">
                        {message.role === "user"
                          ? "You"
                          : thread.harness === "codex"
                            ? "Codex"
                            : "Claude Code"}
                      </span>
                      <div>{message.text}</div>
                    </article>
                  ))}
                  {running && (
                    <p className="thread-activity" role="status">
                      {thread.activity ?? "Working"}
                    </p>
                  )}
                  {thread?.error && (
                    <p className="thread-error" role="alert">
                      {thread.error}
                    </p>
                  )}
                  {thread?.status === "stopped" && <p className="thread-activity">Stopped</p>}
                </div>
                <form
                  className="composer"
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
                  <label className="sr-only" htmlFor="thread-prompt">
                    Message
                  </label>
                  <textarea
                    id="thread-prompt"
                    value={draft.text}
                    onChange={(event) => updateDraft({ text: event.target.value })}
                    placeholder={
                      thread?.doneAt
                        ? "Reopen this thread to continue…"
                        : thread
                          ? "Continue this thread…"
                          : "What would you like to work on?"
                    }
                    disabled={Boolean(thread?.doneAt)}
                    maxLength={32_000}
                    rows={3}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-actions">
                    {thread ? (
                      <span className="harness-label">
                        {thread.harness === "codex" ? "Codex" : "Claude Code"}
                      </span>
                    ) : (
                      <SelectMenu
                        label="Coding harness"
                        value={draft.harness}
                        options={harnesses.map((item) => ({
                          value: item.id,
                          label:
                            item.status === "ready"
                              ? item.name
                              : `${item.name} · ${item.status === "signed-out" ? "Sign in required" : "Not installed"}`,
                        }))}
                        onChange={(value) => updateDraft({ harness: value as HarnessId })}
                        triggerClassName="harness-trigger"
                        placement="top"
                      />
                    )}
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
                          !draft.text.trim() ||
                          busy ||
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

function ThreadCard({
  thread,
  selected,
  now,
  pending,
  onSelect,
  onDone,
}: {
  thread: ThreadSummary;
  selected: boolean;
  now: number;
  pending: boolean;
  onSelect(): void;
  onDone(): void;
}) {
  return (
    <div className={`sidebar-item thread-item ${selected ? "selected" : ""}`}>
      <Button
        className="thread-select"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="thread-title">{thread.title}</span>
        <span className="thread-meta">
          <span>
            {thread.harness === "codex" ? "Codex" : "Claude Code"}
            {thread.status === "running" ? " · Running" : ""}
          </span>
          <time dateTime={thread.updatedAt} title={new Date(thread.updatedAt).toLocaleString()}>
            {relativeThreadTime(thread.updatedAt, now)}
          </time>
        </span>
      </Button>
      <Button
        className="thread-done"
        aria-label={`${thread.doneAt ? "Reopen" : "Mark done:"} ${thread.title}`}
        aria-pressed={Boolean(thread.doneAt)}
        disabled={pending || thread.status === "running"}
        title={
          thread.status === "running"
            ? "Wait for this run to finish"
            : thread.doneAt
              ? "Reopen thread"
              : "Mark thread done"
        }
        onClick={onDone}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="m3 8 3 3 7-7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Done
      </Button>
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
