"use client";

import { mergeCommentPages } from "@/lib/design/comment-pages";
import { Dialog } from "@/components/ui/dialog";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SelectMenu } from "@/components/ui/select-menu";
import {
  addCommentReply,
  addCommentThread,
  changeCommentThreadStatus,
  reactToComment,
  removeCommentThread,
  updateComment,
} from "../comment-client";
import { COMMENT_EMOJIS } from "@/lib/design/comment-emoji";
import type { CommentMessage, CommentReaction, CommentThread } from "@/lib/design/comments";

export type CanvasCommentsHandle = { place: (x: number, y: number) => void };
type Point = { x: number; y: number };

function Avatar({ name, image, size = 32 }: { name: string; image: string | null; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-orange text-xs font-semibold text-on-brand"
      style={{ width: size, height: size }}
      aria-label={name}
    >
      {image ? (
        <span
          className="h-full w-full bg-cover bg-center"
          style={{ backgroundImage: `url(${JSON.stringify(image)})` }}
        />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}

function ThreadMessage({
  message,
  fileId,
  viewerId,
  reactionsAvailable,
  refresh,
}: {
  message: CommentMessage;
  fileId: string;
  viewerId: string | null;
  reactionsAvailable: boolean;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.body);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [reactionDraft, setReactionDraft] = useState<CommentReaction[] | null>(null);
  const [error, setError] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  async function finishEdit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (pending) return;
    if (editText.trim() === message.body) {
      setEditing(false);
      return;
    }
    if (!editText.trim()) {
      setError("Write a comment before leaving the field.");
      editRef.current?.focus();
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await updateComment(fileId, message.id, message.body, editText);
      if (result.error) {
        setError(result.error);
        editRef.current?.focus();
        return;
      }
      setEditing(false);
      await refresh();
    } catch {
      setError("Could not edit comment. Try again.");
      editRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  async function toggleReaction(emoji: string) {
    if (pending) return;
    const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
    setReactionDraft(
      existing
        ? message.reactions
            .map((reaction) =>
              reaction.emoji === emoji
                ? {
                    ...reaction,
                    count: reaction.count + (reaction.reacted ? -1 : 1),
                    reacted: !reaction.reacted,
                  }
                : reaction,
            )
            .filter((reaction) => reaction.count > 0)
        : [...message.reactions, { emoji, count: 1, reacted: true }],
    );
    setPickerOpen(false);
    setPending(true);
    setError("");
    try {
      const result = await reactToComment(fileId, message.id, emoji);
      if (result.error) {
        setError(result.error);
        return;
      }
      await refresh();
    } catch {
      setError("Could not update reaction. Try again.");
    } finally {
      setReactionDraft(null);
      setPending(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Avatar name={message.authorName} image={message.authorImage} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-xs font-semibold">
            {message.authorName}{" "}
            <time className="font-normal text-secondary-ink" dateTime={message.createdAt}>
              {new Date(message.createdAt).toLocaleString()}
            </time>
          </p>
          {viewerId === message.authorId && !editing && (
            <button
              type="button"
              onClick={() => {
                setEditText(message.body);
                setError("");
                setEditing(true);
              }}
              className="shrink-0 text-xs text-secondary-ink hover:text-primary-black hover:underline"
            >
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <textarea
              ref={editRef}
              aria-label="Edit your comment"
              maxLength={2000}
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onBlur={() => void finishEdit()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelled.current = true;
                  setEditing(false);
                  setEditText(message.body);
                  setError("");
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              className="min-h-16 w-full resize-y rounded-md border border-primary-grey p-2 text-sm outline-none focus:border-primary-orange"
            />
            <p className="text-[11px] text-secondary-ink">
              Changes save when you leave the field · Esc cancels
            </p>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.body}</p>
        )}
        {reactionsAvailable && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {(reactionDraft ?? message.reactions).map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                disabled={pending}
                aria-label={`${reaction.emoji} reaction, ${reaction.count}${reaction.reacted ? ", remove yours" : ", add yours"}`}
                aria-pressed={reaction.reacted}
                onClick={() => void toggleReaction(reaction.emoji)}
                className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${reaction.reacted ? "border-primary-orange bg-primary-orange/10" : "border-primary-grey hover:bg-primary-grey/20"}`}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
            <button
              type="button"
              aria-label="Add emoji reaction"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
              className="rounded-full border border-primary-grey px-2 py-0.5 text-xs text-secondary-ink hover:bg-primary-grey/20"
            >
              ☺
            </button>
          </div>
        )}
        {pickerOpen && (
          <div
            role="group"
            aria-label="Choose emoji reaction"
            className="mt-1 flex flex-wrap gap-1 rounded-lg border border-primary-grey/70 bg-surface p-1 shadow-sm"
          >
            {COMMENT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                disabled={pending}
                aria-label={`React with ${emoji}`}
                onClick={() => void toggleReaction(emoji)}
                className="rounded px-1.5 py-1 text-lg hover:bg-primary-grey/20 disabled:opacity-50"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export const CanvasComments = forwardRef<
  CanvasCommentsHandle,
  {
    fileId: string;
    pageId?: string;
    view: { zoom: number; x: number; y: number };
    viewport: React.RefObject<HTMLElement | null>;
    readOnly?: boolean;
    liveVersion?: number;
    toolbarControls?: ReactNode;
  }
>(function CanvasComments(
  { fileId, pageId = "page-1", view, viewport, readOnly = false, liveVersion = 0, toolbarControls },
  ref,
) {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [reactionsAvailable, setReactionsAvailable] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftState, setDraft] = useState<(Point & { pageId: string }) | null>(null);
  const draft = draftState?.pageId === pageId ? draftState : null;
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [posting, setPosting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [canModerateThreads, setCanModerateThreads] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CommentThread | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const postingRef = useRef(false);
  const interactionRef = useRef(0);
  const mutationRef = useRef<{ thread: CommentThread; resolved: boolean | null } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const refreshVersion = useRef(0);
  const loadedPages = useRef(1);
  const focusedThread = useRef<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    focusedThread.current = activeId;
  }, [activeId]);
  useEffect(() => {
    loadedPages.current = 1;
  }, [fileId, pageId]);

  const refresh = useCallback(
    async (ensureThreadId?: string) => {
      const version = ++refreshVersion.current;
      type Page = {
        threads: CommentThread[];
        viewerId: string;
        reactionsAvailable: boolean;
        canModerateThreads: boolean;
        nextCursor?: string | null;
      };
      try {
        const pages: CommentThread[][] = [];
        let cursor: string | null = null;
        let result: Page | undefined;
        const read = async (query: URLSearchParams): Promise<Page> => {
          const response = await fetch(
            `/api/files/${encodeURIComponent(fileId)}/comments?${query}`,
            { cache: "no-store" },
          );
          if (!response.ok) throw new Error("Could not load comments.");
          return response.json();
        };
        for (let index = 0; index < loadedPages.current; index++) {
          const query = new URLSearchParams({ pageId });
          if (cursor) query.set("cursor", cursor);
          result = await read(query);
          if (version !== refreshVersion.current) return;
          pages.push(result.threads);
          cursor = result.nextCursor ?? null;
          if (!cursor) break;
        }
        const selected = ensureThreadId ?? focusedThread.current;
        if (selected) {
          const detail = await read(new URLSearchParams({ pageId, threadId: selected }));
          if (version !== refreshVersion.current) return;
          pages.push(detail.threads);
        }
        if (!result || version !== refreshVersion.current) return;
        const mutation = mutationRef.current;
        setThreads(
          mergeCommentPages(pages).flatMap((thread) =>
            thread.id !== mutation?.thread.id
              ? [thread]
              : mutation.resolved === null
                ? []
                : [{ ...thread, resolved: mutation.resolved }],
          ),
        );
        setNextCursor(cursor);
        setViewerId(result.viewerId);
        setReactionsAvailable(result.reactionsAvailable);
        setCanModerateThreads(result.canModerateThreads);
        setLoadError("");
      } catch {
        if (version === refreshVersion.current) setLoadError("Could not load comments.");
      }
    },
    [fileId, pageId],
  );

  async function loadMore() {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    loadedPages.current++;
    try {
      await refresh();
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(first);
  }, [refresh, liveVersion]);

  useEffect(() => {
    if (draft || activeId) editor.current?.focus();
  }, [draft, activeId]);

  useImperativeHandle(
    ref,
    () => ({
      place(x, y) {
        if (readOnly) return;
        interactionRef.current++;
        setActiveId(null);
        setListOpen(false);
        setOptionsOpen(false);
        setDraft({ x, y, pageId });
        setBody("");
        setError("");
      },
    }),
    [readOnly, pageId],
  );

  const pageThreads = threads.filter((thread) => (thread.pageId ?? "page-1") === pageId);
  const visibleThreads = pageThreads.filter((thread) => !thread.resolved);
  const listedThreads = pageThreads.filter((thread) => thread.resolved === (filter === "resolved"));
  const active = pageThreads.find((thread) => thread.id === activeId);
  const canManageActive = Boolean(
    active && !readOnly && (canModerateThreads || viewerId === active.createdBy),
  );
  const point = draft ?? active ?? null;
  const width = viewport.current?.clientWidth ?? 0;
  const height = viewport.current?.clientHeight ?? 0;
  const popupX = point ? Math.max(12, Math.min(width - 332, point.x * view.zoom + view.x + 22)) : 0;
  const popupY = point
    ? Math.max(12, Math.min(height - 340, point.y * view.zoom + view.y + 22))
    : 0;

  async function post() {
    if (postingRef.current || !body.trim() || readOnly) return;
    postingRef.current = true;
    setPosting(true);
    setError("");
    const interaction = interactionRef.current;
    try {
      const result = draft
        ? await addCommentThread(fileId, draft.x, draft.y, body, pageId)
        : activeId
          ? await addCommentReply(fileId, activeId, body)
          : { error: "Choose a comment thread." };
      if (result.error) {
        if (interaction === interactionRef.current) setError(result.error);
        return;
      }
      if (interaction === interactionRef.current) {
        setBody("");
        if ("id" in result && typeof result.id === "string") {
          setActiveId(result.id);
          setDraft(null);
        }
      }
      await refresh(
        "id" in result && typeof result.id === "string" ? result.id : (activeId ?? undefined),
      );
    } catch {
      if (interaction === interactionRef.current) setError("Could not post comment. Try again.");
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  }

  function openThread(threadId: string) {
    interactionRef.current++;
    setDraft(null);
    setActiveId(threadId);
    setListOpen(false);
    setOptionsOpen(false);
    setBody("");
    setError("");
  }

  async function changeThread(thread: CommentThread, resolved: boolean | null) {
    if (
      mutationRef.current ||
      postingRef.current ||
      readOnly ||
      !(canModerateThreads || viewerId === thread.createdBy)
    )
      return;
    const interaction = ++interactionRef.current;
    mutationRef.current = { thread, resolved };
    // Invalidate reads started before the optimistic mutation.
    refreshVersion.current++;
    setThreads((current) =>
      current.flatMap((item) =>
        item.id !== thread.id ? [item] : resolved === null ? [] : [{ ...item, resolved }],
      ),
    );
    setActiveId(null);
    setOptionsOpen(false);
    setBody("");
    setChanging(true);
    setError("");
    try {
      const result =
        resolved === null
          ? await removeCommentThread(fileId, thread.id)
          : await changeCommentThreadStatus(fileId, thread.id, resolved);
      if (result.error) throw new Error(result.error);
    } catch (cause) {
      setThreads((current) => [...current.filter((item) => item.id !== thread.id), thread]);
      if (interaction === interactionRef.current) {
        setActiveId(thread.id);
        setError(cause instanceof Error ? cause.message : "Could not update thread. Try again.");
      }
    } finally {
      mutationRef.current = null;
      setChanging(false);
      // Reads never change the selected thread or clear a newer draft.
      void refresh();
    }
  }

  return (
    <div data-canvas-control className="pointer-events-none absolute inset-0 z-20">
      {visibleThreads.map((thread) => {
        const first = thread.preview ?? thread.messages[0];
        return (
          <button
            key={thread.id}
            type="button"
            title={`Comment by ${first?.authorName ?? "user"}`}
            aria-label={`Open comment by ${first?.authorName ?? "user"}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => openThread(thread.id)}
            className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-surface shadow-md focus-visible:outline-2 focus-visible:outline-primary-orange ${activeId === thread.id ? "border-primary-orange" : "border-handle"}`}
            style={{ left: thread.x * view.zoom + view.x, top: thread.y * view.zoom + view.y }}
          >
            <Avatar
              name={first?.authorName ?? "User"}
              image={first?.authorImage ?? null}
              size={30}
            />
          </button>
        );
      })}
      {(pageThreads.length > 0 || nextCursor || toolbarControls) && (
        <div
          className="absolute left-4 right-4 top-4 flex items-center justify-end gap-2"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          {(pageThreads.length > 0 || nextCursor) && (
            <button
              type="button"
              aria-expanded={listOpen}
              aria-controls="comment-list"
              onClick={() => setListOpen((open) => !open)}
              className="pointer-events-auto flex h-8 shrink-0 items-center rounded-md border border-primary-grey/80 bg-surface px-2.5 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
            >
              Comments ({pageThreads.length}
              {nextCursor ? "+" : ""})
            </button>
          )}
          {toolbarControls && <div className="pointer-events-auto shrink-0">{toolbarControls}</div>}
          {(pageThreads.length > 0 || nextCursor) && listOpen && (
            <section
              id="comment-list"
              aria-label="Comments"
              className="pointer-events-auto absolute right-0 top-full mt-2 w-64 max-w-full rounded-lg border border-primary-grey/70 bg-surface p-2 shadow-lg"
            >
              <SelectMenu
                label="Comment status"
                value={filter}
                onChange={(value) => setFilter(value as "open" | "resolved")}
                options={[
                  { value: "open", label: `Open (${visibleThreads.length})` },
                  {
                    value: "resolved",
                    label: `Resolved (${pageThreads.length - visibleThreads.length})`,
                  },
                ]}
              />
              {listedThreads.length > 0 && (
                <div className="mt-2 max-h-64 overflow-y-auto">
                  {listedThreads.map((thread) => {
                    const first = thread.preview ?? thread.messages[0];
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => openThread(thread.id)}
                        className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-primary-grey/15"
                      >
                        <Avatar
                          name={first?.authorName ?? "User"}
                          image={first?.authorImage ?? null}
                          size={24}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium">
                            {first?.authorName ?? "User"}
                          </span>
                          <span className="block truncate text-xs text-secondary-ink">
                            {first?.body}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {nextCursor && (
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="mt-2 w-full rounded-md px-2 py-2 text-xs hover:bg-primary-grey/15 disabled:opacity-50"
                >
                  More comments
                </button>
              )}
            </section>
          )}
        </div>
      )}
      <Dialog
        ref={deleteDialog}
        aria-labelledby="delete-comment-title"
        aria-describedby="delete-comment-description"
        size="sm"
        className="pointer-events-auto"
      >
        <h2 id="delete-comment-title" className="text-lg font-semibold">
          Delete thread?
        </h2>
        <p id="delete-comment-description" className="mt-3 text-sm text-secondary-ink">
          This permanently deletes the comment and all replies.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            autoFocus
            onClick={() => deleteDialog.current?.close()}
            className="rounded-lg px-4 py-2 text-sm hover:bg-primary-grey/20"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              deleteDialog.current?.close();
              if (deleteTarget) void changeThread(deleteTarget, null);
            }}
            className="rounded-lg bg-danger-fill px-4 py-2 text-sm font-medium text-on-danger hover:bg-danger-fill-hover"
          >
            Delete thread
          </button>
        </div>
      </Dialog>
      {draft && (
        <span
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary-orange bg-surface shadow-md"
          style={{ left: draft.x * view.zoom + view.x, top: draft.y * view.zoom + view.y }}
        >
          <Avatar name="New comment" image={null} size={30} />
        </span>
      )}
      {point && (
        <section
          aria-label="Comment thread"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          className="pointer-events-auto absolute flex max-h-[min(24rem,calc(100%-1.5rem))] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-primary-grey/70 bg-surface shadow-xl"
          style={{ left: popupX, top: popupY }}
        >
          <div className="relative flex items-center justify-between gap-2 border-b border-primary-grey/70 px-3 py-2">
            <h2 className="text-sm font-semibold">
              {draft ? "New comment" : active?.resolved ? "Resolved comment" : "Comment thread"}
            </h2>
            <div className="flex items-center gap-2">
              {active && canManageActive && (
                <>
                  <button
                    type="button"
                    disabled={changing || posting}
                    onClick={() => void changeThread(active, !active.resolved)}
                    className="text-xs hover:underline disabled:opacity-50"
                  >
                    {active?.resolved ? "Reopen" : "Resolve"}
                  </button>
                  <button
                    type="button"
                    aria-label="Thread options"
                    aria-expanded={optionsOpen}
                    disabled={changing || posting}
                    onClick={() => setOptionsOpen((open) => !open)}
                    className="rounded px-2 text-secondary-ink hover:bg-primary-grey/20"
                  >
                    …
                  </button>
                </>
              )}
              <button
                type="button"
                aria-label="Close comments"
                onClick={() => {
                  interactionRef.current++;
                  setDraft(null);
                  setActiveId(null);
                  setOptionsOpen(false);
                  setError("");
                }}
                className="rounded px-2 text-lg text-secondary-ink hover:bg-primary-grey/20"
              >
                ×
              </button>
            </div>
            {optionsOpen && active && canManageActive && (
              <div className="absolute right-3 top-full z-10 rounded-lg border border-primary-grey/70 bg-surface p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setDeleteTarget(active);
                    setOptionsOpen(false);
                    deleteDialog.current?.showModal();
                  }}
                  className="rounded px-3 py-2 text-xs text-danger hover:bg-danger/5"
                >
                  Delete thread
                </button>
              </div>
            )}
          </div>
          {active && (
            <div className="min-h-0 space-y-3 overflow-y-auto px-3 py-3">
              {active.messages.map((message) => (
                <ThreadMessage
                  key={message.id}
                  message={message}
                  fileId={fileId}
                  viewerId={viewerId}
                  reactionsAvailable={reactionsAvailable}
                  refresh={refresh}
                />
              ))}
            </div>
          )}
          {!readOnly && (
            <div className="border-t border-primary-grey/70 p-3">
              <textarea
                ref={editor}
                aria-label={draft ? "Write a comment" : "Write a reply"}
                placeholder={draft ? "Write a comment…" : "Reply…"}
                maxLength={2000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void post();
                  }
                }}
                className="min-h-18 w-full resize-y rounded-md border border-primary-grey p-2 text-sm outline-none focus:border-primary-orange"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-secondary-ink">
                  Enter to post · Shift+Enter for newline
                </span>
                <button
                  type="button"
                  disabled={!body.trim() || posting}
                  onClick={() => void post()}
                  className="rounded-md bg-strong-action px-3 py-1.5 text-xs font-medium text-on-strong-action disabled:opacity-40"
                >
                  Post
                </button>
              </div>
            </div>
          )}
          {(error || loadError) && (
            <p role="alert" className="px-3 pb-2 text-xs text-danger">
              {error || loadError}
            </p>
          )}
        </section>
      )}
      {(error || loadError) && !point && (
        <p
          role="alert"
          className="pointer-events-auto absolute bottom-16 left-4 rounded-md bg-surface p-2 text-xs text-danger shadow"
        >
          {error || loadError}
        </p>
      )}
    </div>
  );
});
