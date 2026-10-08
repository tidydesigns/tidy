"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { threadsPage } from "@/components/workspace/page-layout";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentDraft } from "./draft-store";
import { SelectMenu } from "@/components/ui/select-menu";
import {
  activeRunStatuses,
  runLabels,
  type ConnectionStatus,
  type ThreadSnapshot,
  type ThreadSummary,
  type ThreadEvent,
} from "@/lib/agents/protocol";

export type ThreadsWorkspaceProps = {
  organizationId: string;
  userId: string;
  canEdit: boolean;
  canManage: boolean;
  files: { id: string; name: string }[];
  initialThreads: ThreadSummary[];
  initialSnapshot: ThreadSnapshot | null;
  connection: ConnectionStatus;
  fileId?: string;
  selectedNodeIds?: string[];
  onClose?: () => void;
  openThreadId?: string;
};
const control =
  "inline-flex items-center justify-center rounded-lg border border-primary-grey px-3 py-2 text-sm hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

export function ThreadsWorkspace({
  organizationId,
  userId,
  canEdit,
  canManage,
  files,
  initialThreads,
  initialSnapshot,
  connection,
  fileId,
  selectedNodeIds = [],
  onClose,
  openThreadId,
}: ThreadsWorkspaceProps) {
  const [threads, setThreads] = useState(initialThreads),
    [snapshot, setSnapshot] = useState(initialSnapshot);
  const [olderThreads, setOlderThreads] = useState<ThreadSummary[]>([]);
  const [hasMoreThreads, setHasMoreThreads] = useState(true),
    [loadingOlder, setLoadingOlder] = useState(false);
  const allThreads = [
    ...threads,
    ...olderThreads.filter((old) => !threads.some((thread) => thread.id === old.id)),
  ];
  const [selected, setSelected] = useState<string | null>(
    openThreadId ?? initialSnapshot?.thread.id ?? null,
  );
  const [target, setTarget] = useState(fileId ?? files[0]?.id ?? ""),
    [agentLimit, setAgentLimit] = useState("1");
  const [prompt, setPrompt] = useAgentDraft(
    `tidy:agent-draft:${userId}:${organizationId}:${selected ?? fileId ?? "new"}`,
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [allowOrganizationChanges, setAllowOrganizationChanges] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [scope, setScope] = useState(fileId ? "file" : "organisation");
  const scopeRef = useRef(scope);
  const cache = useRef(
    new Map(initialSnapshot ? [[initialSnapshot.thread.id, initialSnapshot]] : []),
  );
  const selectedRef = useRef(selected);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const run = snapshot?.thread.run;
  const active = Boolean(run && activeRunStatuses.includes(run.status));
  const ownsRun = run?.ownerId === userId;
  const loadThread = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/agents/threads/${id}`, { signal });
    const data = (await response.json()) as ThreadSnapshot & { error?: string };
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) {
        cache.current.delete(id);
        if (selectedRef.current === id) setSnapshot(null);
      }
      throw new Error(data.error);
    }
    if (signal?.aborted) return;
    const previous = cache.current.get(id);
    if (previous && previous.thread.sequence > data.thread.sequence) return;
    const first = data.messages[0]?.sequence ?? Infinity;
    const earlier = previous?.messages.filter((message) => message.sequence < first) ?? [];
    const merged: ThreadSnapshot = {
      ...data,
      messages: [...earlier, ...data.messages],
      hasOlder: earlier.length ? previous!.hasOlder : data.hasOlder,
    };
    cache.current.set(id, merged);
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id && thread.sequence <= merged.thread.sequence
          ? { ...merged.thread, cursor: thread.cursor }
          : thread,
      ),
    );
    if (selectedRef.current === id) setSnapshot(merged);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let lastList = 0;
    const poll = async () => {
      try {
        if (Date.now() - lastList >= 5000) {
          const params = new URLSearchParams({ organizationId });
          if (scope === "file" && fileId) params.set("fileId", fileId);
          const response = await fetch(`/api/agents/threads?${params}`, {
            signal: controller.signal,
          });
          const data = (await response.json()) as { threads: ThreadSummary[]; error?: string };
          if (controller.signal.aborted) return;
          if (!response.ok) {
            if ([401, 403].includes(response.status)) {
              cache.current.clear();
              setThreads([]);
              setOlderThreads([]);
              setSnapshot(null);
            }
            throw new Error(data.error);
          }
          lastList = Date.now();
          // Preserve positions of existing rows during activity updates.
          setThreads((current) => {
            const incoming = new Map<string, ThreadSummary>(
              (data.threads as ThreadSummary[]).map((thread) => [thread.id, thread]),
            );
            const kept = current.flatMap((thread) =>
              incoming.has(thread.id)
                ? [
                    thread.sequence > incoming.get(thread.id)!.sequence
                      ? thread
                      : incoming.get(thread.id)!,
                  ]
                : [],
            );
            return [
              ...(data.threads as ThreadSummary[]).filter(
                (thread) => !current.some((old) => old.id === thread.id),
              ),
              ...kept,
            ];
          });
        }
        if (selectedRef.current) {
          const id = selectedRef.current,
            cached = cache.current.get(id);
          if (!cached) await loadThread(id, controller.signal);
          else {
            const response = await fetch(
              `/api/agents/threads/${id}/events?after=${cached.thread.sequence}`,
              { signal: controller.signal },
            );
            const data = (await response.json()) as { events: ThreadEvent[]; error?: string };
            if (!response.ok) {
              if ([401, 403, 404].includes(response.status)) {
                cache.current.delete(id);
                if (selectedRef.current === id) setSnapshot(null);
              }
              throw new Error(data.error);
            }
            if (data.events.length) await loadThread(id, controller.signal);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Reconnecting…");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [organizationId, fileId, scope, loadThread]);
  function openThread(id: string | null) {
    selectedRef.current = id;
    setSelected(id);
    setSnapshot(id ? (cache.current.get(id) ?? null) : null);
    setError("");
    if (id) void loadThread(id).catch((error) => setError(error.message));
  }
  useEffect(() => {
    if (!openThreadId) return;
    void loadThread(openThreadId).catch((error) => setError(error.message));
  }, [openThreadId, loadThread]);
  async function send() {
    const content = prompt.trim();
    if (!content || busy || (selected && snapshot?.thread.id !== selected)) return;
    const steering = active && ownsRun;
    if (run?.status === "limited") return;
    const key = JSON.stringify({
      content,
      selected,
      target,
      attachments,
      selectedNodeIds,
      agentLimit,
      allowOrganizationChanges,
      steering,
    });
    if (requestRef.current?.key !== key) requestRef.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        steering ? `/api/agents/runs/${run!.id}` : "/api/agents/threads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            steering
              ? { requestId: requestRef.current.id, content }
              : {
                  requestId: requestRef.current.id,
                  organizationId,
                  threadId: selected ?? undefined,
                  prompt: content,
                  agentLimit: Number(agentLimit),
                  allowOrganizationChanges,
                  files: snapshot?.thread.files.length
                    ? snapshot.thread.files.map((file) => ({
                        id: file.id,
                        selectedNodeIds: file.selectedNodeIds,
                      }))
                    : [...new Set([target, ...attachments])].map((id) => ({
                        id,
                        selectedNodeIds: id === fileId ? selectedNodeIds : [],
                      })),
                },
          ),
        },
      );
      const data = (await response.json()) as { threadId?: string; error?: string };
      if (!response.ok) throw new Error(data.error);
      setPrompt((current) => (current.trim() === content ? "" : current));
      requestRef.current = null;
      if (data.threadId) {
        selectedRef.current = data.threadId;
        setSelected(data.threadId);
      }
      if (selectedRef.current) await loadThread(selectedRef.current);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send your message.");
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/agents/runs/${run.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error);
      await loadThread(run.threadId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not stop the run.");
    } finally {
      setBusy(false);
    }
  }
  async function moreThreads() {
    const requestedScope = scope;
    const cursor = (olderThreads.at(-1) ?? threads.at(-1))?.cursor;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const params = new URLSearchParams({ organizationId, before: cursor });
      if (scope === "file" && fileId) params.set("fileId", fileId);
      const response = await fetch(`/api/agents/threads?${params}`);
      const data = (await response.json()) as { threads: ThreadSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error);
      if (scopeRef.current !== requestedScope) return;
      setOlderThreads((current) => [
        ...current,
        ...data.threads.filter((thread) => !current.some((old) => old.id === thread.id)),
      ]);
      setHasMoreThreads(data.threads.length === 50);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load older threads.");
    } finally {
      setLoadingOlder(false);
    }
  }
  async function rename() {
    const id = selected,
      title = titleDraft.trim();
    setRenaming(false);
    if (!id || !title || title === snapshot?.thread.title) return;
    try {
      const response = await fetch(`/api/agents/threads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error("Could not rename the thread.");
      await loadThread(id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not rename the thread.");
    }
  }
  async function older() {
    if (!snapshot || !selected) return;
    const id = selected,
      before = snapshot.messages[0]?.sequence;
    try {
      const response = await fetch(`/api/agents/threads/${id}?before=${before}`);
      const data: ThreadSnapshot & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (selectedRef.current === id)
        setSnapshot((current) => {
          if (!current) return current;
          const next = {
            ...current,
            hasOlder: data.hasOlder,
            messages: [
              ...data.messages,
              ...current.messages.filter(
                (message) => !data.messages.some((old) => old.id === message.id),
              ),
            ],
          };
          cache.current.set(id, next);
          return next;
        });
    } catch {
      setError("Could not load earlier messages.");
    }
  }
  return (
    <section
      data-page-content={onClose ? undefined : "threads"}
      className={onClose ? "flex min-h-0 flex-col h-full" : threadsPage}
      aria-label="Agent threads"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-primary-grey pb-4">
        <h1 className="text-lg font-semibold">Threads</h1>
        <div className="flex items-center gap-2">
          {fileId && (
            <SelectMenu
              value={scope}
              onChange={(value) => {
                scopeRef.current = value;
                setScope(value);
                setOlderThreads([]);
                setHasMoreThreads(true);
              }}
              label="Thread scope"
              size="sm"
              options={[
                { value: "file", label: "This file" },
                { value: "organisation", label: "Organisation" },
              ]}
            />
          )}
          {canEdit && (
            <button className={control} onClick={() => openThread(null)}>
              New thread
            </button>
          )}
          {onClose && (
            <button className={control} aria-label="Close threads" onClick={onClose}>
              ×
            </button>
          )}
        </div>
      </header>
      <div
        className={`grid min-h-0 flex-1 ${onClose ? "grid-rows-[auto_minmax(0,1fr)]" : "md:grid-cols-[220px_minmax(0,1fr)]"}`}
      >
        {allThreads.length > 0 && (
          <nav
            aria-label="Threads"
            className={`overflow-auto ${onClose ? "max-h-36 border-b" : "max-md:max-h-36 md:border-r"} border-primary-grey py-2`}
          >
            {allThreads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => openThread(thread.id)}
                aria-current={selected === thread.id ? "true" : undefined}
                className={`block w-full rounded-lg px-3 py-3 text-left hover:bg-hover-surface ${selected === thread.id ? "bg-hover-surface" : ""}`}
              >
                <span className="block truncate text-sm font-medium">{thread.title}</span>
                <span className="mt-1 block truncate text-xs text-secondary-ink">
                  {thread.run?.ownerName}
                  {thread.run && ` · ${runLabels[thread.run.status]}`}
                  {thread.activeAgents > 0 && ` · ${thread.activeAgents} agents`}
                </span>
              </button>
            ))}
            {hasMoreThreads && threads.length >= 50 && (
              <button
                className="px-3 py-2 text-xs underline"
                disabled={loadingOlder}
                onClick={() => void moreThreads()}
              >
                Earlier threads
              </button>
            )}
          </nav>
        )}
        <div
          className={`flex min-h-0 min-w-0 flex-col ${allThreads.length && !onClose ? "md:pl-5" : "col-span-full"}`}
        >
          {snapshot && (
            <div className="flex shrink-0 items-start justify-between gap-3 py-4">
              <div className="min-w-0">
                {renaming ? (
                  <input
                    aria-label="Thread title"
                    autoFocus
                    className="w-full rounded border border-primary-grey bg-surface px-2 py-1 text-sm"
                    value={titleDraft}
                    maxLength={120}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={() => void rename()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRenaming(false);
                      }
                    }}
                  />
                ) : (
                  <button
                    disabled={!canEdit}
                    className="max-w-full truncate text-left text-sm font-medium"
                    title={canEdit ? "Rename thread" : undefined}
                    onClick={() => {
                      setTitleDraft(snapshot.thread.title);
                      setRenaming(true);
                    }}
                  >
                    {snapshot.thread.title}
                  </button>
                )}
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-secondary-ink">
                  {snapshot.thread.files.map((file) => (
                    <Link
                      className="underline underline-offset-4"
                      key={file.id}
                      prefetchOnIntent
                      href={`/files/${file.id}`}
                    >
                      {file.name}
                    </Link>
                  ))}
                </div>
              </div>
              {active && (ownsRun || canManage) && (
                <button disabled={busy} className={control} onClick={() => void stop()}>
                  Stop
                </button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto py-3" aria-label="Conversation">
            {snapshot?.hasOlder && (
              <button onClick={() => void older()} className="mb-4 text-xs underline">
                Earlier messages
              </button>
            )}
            {snapshot?.messages
              .filter((message) => !message.agentId || !message.isWorker)
              .map((message) => (
                <article key={message.id} className="mb-6">
                  <p className="mb-2 text-xs font-medium text-secondary-ink">
                    {message.authorName}
                    {message.delivery === "pending"
                      ? " · Pending"
                      : message.delivery === "interrupted"
                        ? " · Interrupted"
                        : ""}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6">
                    {message.content}
                  </p>
                </article>
              ))}
          </div>
          {snapshot && snapshot.workers.length > 0 && (
            <details className="shrink-0 border-t border-primary-grey py-3">
              <summary className="cursor-pointer text-xs text-secondary-ink">
                {snapshot.workers.length} {snapshot.workers.length === 1 ? "agent" : "agents"} ·{" "}
                {run ? runLabels[run.status] : ""}
              </summary>
              <ul className="mt-3 max-h-44 space-y-3 overflow-auto">
                {snapshot.workers.map((worker) => (
                  <li key={worker.id} className="text-xs">
                    <span className="font-medium">{worker.name}</span>
                    <span className="text-secondary-ink"> · {worker.status}</span>
                    <p className="mt-1 text-secondary-ink">{worker.task}</p>
                    {worker.parentId && (
                      <details className="mt-2">
                        <summary className="cursor-pointer">Activity</summary>
                        {snapshot.messages
                          .filter((message) => message.agentId === worker.id)
                          .map((message) => (
                            <p key={message.id} className="mt-2 whitespace-pre-wrap leading-5">
                              {message.content}
                            </p>
                          ))}
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {run?.reason && ["failed", "limited"].includes(run.status) && (
            <p role="status" className="py-2 text-xs text-secondary-ink">
              {run.reason === "runner_disconnected"
                ? "The runner disconnected. Completed edits remain. Send a new prompt to continue."
                : run.reason === "connection_required"
                  ? "Reconnect Codex in settings to continue."
                  : run.status === "limited"
                    ? "Your Codex usage limit was reached. Stop this run, then start again when usage is available."
                    : "The run could not finish. Completed edits remain. Send a new prompt to continue."}
            </p>
          )}
          {error && (
            <p role="alert" className="py-2 text-xs text-danger">
              {error}
            </p>
          )}
          {canEdit && (
            <form
              className="shrink-0 border-t border-primary-grey pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {!selected && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <SelectMenu
                    value={target}
                    onChange={setTarget}
                    label="Target file"
                    size="sm"
                    options={files.map((file) => ({ value: file.id, label: file.name }))}
                  />
                  {attachments
                    .filter((id) => id !== target)
                    .map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="rounded-md border border-primary-grey px-2 py-1 text-xs"
                        aria-label={`Remove ${files.find((file) => file.id === id)?.name}`}
                        onClick={() =>
                          setAttachments((current) => current.filter((value) => value !== id))
                        }
                      >
                        {files.find((file) => file.id === id)?.name} ×
                      </button>
                    ))}
                  {files.length > 1 && attachments.length < 9 && (
                    <SelectMenu
                      value=""
                      label="Attach another file"
                      size="sm"
                      onChange={(id) => {
                        if (id) setAttachments((current) => [...current, id]);
                      }}
                      options={[
                        { value: "", label: "Add file" },
                        ...files
                          .filter((file) => file.id !== target && !attachments.includes(file.id))
                          .map((file) => ({ value: file.id, label: file.name })),
                      ]}
                    />
                  )}
                  {fileId === target && selectedNodeIds.length > 0 && (
                    <span className="text-xs text-secondary-ink">
                      {selectedNodeIds.length} selected layers
                    </span>
                  )}
                </div>
              )}
              {connection.status !== "connected" ? (
                <Link
                  prefetchOnIntent
                  href="/settings?tab=agents"
                  className="inline-flex py-2 text-sm underline underline-offset-4"
                >
                  Connect Codex to start a thread
                </Link>
              ) : active && !ownsRun ? (
                <p className="py-2 text-xs text-secondary-ink">
                  {run?.ownerName} is directing this run.
                </p>
              ) : (
                <>
                  {!active && (
                    <details className="mb-2 text-xs text-secondary-ink">
                      <summary className="cursor-pointer">Tool access</summary>
                      <label className="mt-2 flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={allowOrganizationChanges}
                          onChange={(event) => setAllowOrganizationChanges(event.target.checked)}
                        />
                        Allow new files and folder changes in this organisation
                      </label>
                    </details>
                  )}
                  <textarea
                    aria-label={active ? "Direct your agents" : "Describe the design work"}
                    placeholder={active ? "Direct your agents…" : "What would you like to work on?"}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    maxLength={16000}
                    rows={3}
                    className="w-full resize-none rounded-lg border border-primary-grey bg-surface p-3 text-sm focus:outline-2 focus:outline-accent"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    {!active && (
                      <SelectMenu
                        value={agentLimit}
                        onChange={setAgentLimit}
                        label="Maximum agents"
                        size="sm"
                        options={Array.from({ length: 6 }, (_, index) => ({
                          value: String(index + 1),
                          label: `${index + 1} ${index ? "agents" : "agent"}`,
                        }))}
                      />
                    )}
                    <button
                      type="submit"
                      className={control}
                      disabled={
                        busy ||
                        run?.status === "limited" ||
                        Boolean(selected && snapshot?.thread.id !== selected) ||
                        !prompt.trim() ||
                        (!selected && !target)
                      }
                    >
                      {busy ? "Sending…" : "Send"}
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] text-secondary-ink">
                    Your subscription · Shared with your team
                  </p>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
