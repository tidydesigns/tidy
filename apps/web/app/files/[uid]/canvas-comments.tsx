"use client";

import { createPortal } from "react-dom";
import { EditorNotification } from "./editor-notification";
import { mergeCommentPages } from "@/lib/design/comment-pages";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/dialog";
import {
  forwardRef,
  memo,
  useMemo,
  useLayoutEffect,
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
import {
  commentEmojiSchema,
  commentPageSchema,
  type CommentPage,
  type CommentMessage,
  type CommentThread,
} from "@/lib/design/comment-contract";
import { readJsonResponse } from "@/lib/http/json-response";

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

function SendingStatus() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p role="status" className="ml-9 mt-1 h-4 text-xs text-secondary-ink">
      <span className={visible ? undefined : "sr-only"}>Sending…</span>
    </p>
  );
}

type ReactionDraft = {
  emoji: (typeof COMMENT_EMOJIS)[number];
  reacted: boolean;
} & ({ kind: "sending" } | { kind: "sent"; ackVersion: number });

const ThreadMessage = memo(function ThreadMessage({
  message,
  fileId,
  viewerId,
  reactionsAvailable,
  refresh,
  readVersion,
  latestReadVersion,
}: {
  message: CommentMessage;
  fileId: string;
  viewerId: string | null;
  reactionsAvailable: boolean;
  refresh: () => Promise<void>;
  readVersion: number;
  latestReadVersion: () => number;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.body);
  const [pending, setPending] = useState(false);
  const [reactionDrafts, setReactionDrafts] = useState<ReactionDraft[]>([]);
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
      const result = await updateComment({
        fileId,
        messageId: message.id,
        previousBody: message.body,
        body: editText,
      });
      if (result.kind === "error") {
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

  // A read started before acknowledgement cannot retire the local intent.
  const activeReactions = reactionDrafts.filter(
    (draft) => draft.kind === "sending" || readVersion <= draft.ackVersion,
  );
  let reactions = message.reactions;
  for (const activeReaction of activeReactions) {
    const existing = reactions.find((reaction) => reaction.emoji === activeReaction.emoji);
    reactions = existing
      ? reactions
          .map((reaction) =>
            reaction.emoji === activeReaction.emoji
              ? {
                  ...reaction,
                  count: reaction.count + Number(activeReaction.reacted) - Number(reaction.reacted),
                  reacted: activeReaction.reacted,
                }
              : reaction,
          )
          .filter((reaction) => reaction.count > 0)
      : activeReaction.reacted
        ? [...reactions, { emoji: activeReaction.emoji, count: 1, reacted: true }]
        : reactions;
  }

  async function toggleReaction(value: string) {
    if (pending) return;
    const parsed = commentEmojiSchema.safeParse(value);
    if (!parsed.success) {
      setError("This reaction is no longer supported.");
      return;
    }
    const emoji = parsed.data;
    const existing = reactions.find((reaction) => reaction.emoji === emoji);
    const previousDrafts = reactionDrafts;
    const change = { emoji, reacted: !existing?.reacted };
    setReactionDrafts([
      ...activeReactions.filter((draft) => draft.emoji !== emoji),
      { ...change, kind: "sending" },
    ]);
    setPending(true);
    setError("");
    try {
      const result = await reactToComment({ fileId, messageId: message.id, emoji });
      if (result.kind === "error") throw new Error(result.error);
      const ackVersion = latestReadVersion();
      setReactionDrafts((current) =>
        current.map((draft) =>
          draft.emoji === emoji ? { ...change, kind: "sent", ackVersion } : draft,
        ),
      );
      void refresh();
    } catch (cause) {
      setReactionDrafts(previousDrafts);
      setError(cause instanceof Error ? cause.message : "Could not update reaction. Try again.");
      // A lost response may still have committed. Read the state without replaying a toggle.
      void refresh();
    } finally {
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
              data-ph-public
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
              data-ph-public-label
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
            <p data-ph-public className="text-[11px] text-secondary-ink">
              Changes save when you leave the field · Esc cancels
            </p>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.body}</p>
        )}
        {reactionsAvailable && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                disabled={pending}
                aria-label={`${reaction.emoji} reaction, ${reaction.count}${reaction.reacted ? ", remove yours" : ", add yours"}`}
                aria-pressed={reaction.reacted}
                onClick={() => void toggleReaction(reaction.emoji)}
                className={`rounded-full border px-2 py-0.5 text-xs ${reaction.reacted ? "border-primary-orange bg-primary-orange/10" : "border-primary-grey hover:bg-primary-grey/20"}`}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
            <SelectMenu
              label="Add emoji reaction"
              replayLabel
              replayOptions
              actionMenu
              layout="horizontal"
              placement="top"
              align="start"
              dismissOnScroll
              value=""
              disabled={pending}
              triggerContent="☺"
              triggerClassName="rounded-full border border-primary-grey px-2 py-0.5 text-xs text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
              options={COMMENT_EMOJIS.map((emoji) => ({
                value: emoji,
                label: emoji,
                ariaLabel: `React with ${emoji}`,
              }))}
              onChange={(emoji) => void toggleReaction(emoji)}
            />
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
});

type Submission = {
  fileId: string;
  thread: CommentThread;
  create: boolean;
} & (
  | { kind: "sending" }
  | { kind: "sent"; legacyReceipt: boolean; ackVersion: number }
  | { kind: "failed"; error: string }
);

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
    notificationRoot: HTMLElement | null;
  }
>(function CanvasComments(
  {
    fileId,
    pageId = "page-1",
    view,
    viewport,
    readOnly = false,
    liveVersion = 0,
    toolbarControls,
    notificationRoot,
  },
  ref,
) {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [reactionsAvailable, setReactionsAvailable] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftState, setDraft] = useState<(Point & { pageId: string }) | null>(null);
  const draft = draftState?.pageId === pageId ? draftState : null;
  const [body, setBodyState] = useState("");
  const bodyRef = useRef("");
  const setBody = useCallback((value: string) => {
    bodyRef.current = value;
    setBodyState(value);
  }, []);
  const [viewer, setViewer] = useState<{ name: string; image: string | null } | null>(null);
  const [submissions, setSubmissionState] = useState<Submission[]>([]);
  const submissionsRef = useRef<Submission[]>([]);
  const setSubmissions = useCallback((update: (current: Submission[]) => Submission[]) => {
    submissionsRef.current = update(submissionsRef.current);
    setSubmissionState(submissionsRef.current);
  }, []);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const posting = submissions.some(
    (submission) => submission.thread.id === activeId && submission.kind === "sending",
  );
  const [changing, setChanging] = useState(false);
  const [canModerateThreads, setCanModerateThreads] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CommentThread | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const creationRequests = useRef(new Map<string, Promise<boolean>>());
  const messageList = useRef<HTMLDivElement>(null);
  const scrollRequest = useRef<string | null>(null);
  const readController = useRef<AbortController | null>(null);
  const interactionRef = useRef(0);
  const mutationRef = useRef<{ thread: CommentThread; resolved: boolean | null } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const refreshVersion = useRef(0);
  const [confirmedRead, setConfirmedRead] = useState({
    version: 0,
    messageIds: new Set<string>(),
  });
  const latestReadVersion = useCallback(() => refreshVersion.current, []);
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
      readController.current?.abort();
      const controller = new AbortController();
      readController.current = controller;
      try {
        const pages: CommentThread[][] = [];
        let cursor: string | null = null;
        let result: CommentPage | undefined;
        const read = async (query: URLSearchParams): Promise<CommentPage> => {
          const response = await fetch(
            `/api/files/${encodeURIComponent(fileId)}/comments?${query}`,
            { cache: "no-store", signal: controller.signal },
          );
          return readJsonResponse({
            response,
            schema: commentPageSchema,
            message: "Could not load comments.",
          });
        };
        const selected = ensureThreadId ?? focusedThread.current;
        // The list and focused thread are independent reads; do not make posting wait for both in sequence.
        const [firstPage, detail] = await Promise.all([
          read(new URLSearchParams({ pageId })),
          selected ? read(new URLSearchParams({ pageId, threadId: selected })) : null,
        ]);
        for (let index = 0; index < loadedPages.current; index++) {
          const query = new URLSearchParams({ pageId });
          if (cursor) query.set("cursor", cursor);
          result = index === 0 ? firstPage : await read(query);
          if (version !== refreshVersion.current) return;
          pages.push(result.threads);
          cursor = result.nextCursor ?? null;
          if (!cursor) break;
        }
        if (detail) pages.push(detail.threads);
        if (!result || version !== refreshVersion.current) return;
        const mutation = mutationRef.current;
        const merged = mergeCommentPages(pages);
        setThreads(
          merged.flatMap((thread) =>
            thread.id !== mutation?.thread.id
              ? [thread]
              : mutation.resolved === null
                ? []
                : [{ ...thread, resolved: mutation.resolved }],
          ),
        );
        // Retain local sends until an authoritative read contains their stable message IDs.
        const received = new Set(
          merged.flatMap((thread) => thread.messages.map((message) => message.id)),
        );
        setSubmissions((current) =>
          current.filter((submission) => {
            // Only a detail read started after acknowledgement can confirm deletion.
            const goneAfterAck =
              submission.kind === "sent" &&
              version > submission.ackVersion &&
              selected === submission.thread.id &&
              detail !== null &&
              !detail.threads.some((thread) => thread.id === submission.thread.id);
            const legacyConfirmed =
              submission.kind === "sent" &&
              submission.legacyReceipt &&
              detail?.threads.some((thread) => thread.id === submission.thread.id);
            if (
              !received.has(submission.thread.messages[0].id) &&
              !legacyConfirmed &&
              !goneAfterAck
            )
              return true;
            if (submission.create) creationRequests.current.delete(submission.thread.id);
            return false;
          }),
        );
        setConfirmedRead({ version, messageIds: received });
        setNextCursor(cursor);
        setViewerId(result.viewerId);
        if (result.viewer) setViewer(result.viewer);
        setReactionsAvailable(result.reactionsAvailable);
        setCanModerateThreads(result.canModerateThreads);
        setLoadError("");
      } catch {
        if (version === refreshVersion.current) setLoadError("Could not load comments.");
      }
    },
    [fileId, pageId, setSubmissions],
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

  useEffect(
    () => () => {
      refreshVersion.current++;
      readController.current?.abort();
    },
    [fileId, pageId],
  );

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
    [readOnly, pageId, setBody],
  );

  const pageThreads = useMemo(
    () =>
      mergeCommentPages([
        threads,
        submissions
          .filter((submission) => submission.fileId === fileId)
          .map((submission) => {
            const remote = threads.find((thread) => thread.id === submission.thread.id);
            return {
              ...submission.thread,
              ...(remote ? { resolved: remote.resolved, preview: remote.preview } : {}),
            };
          }),
      ]).filter((thread) => (thread.pageId ?? "page-1") === pageId),
    [threads, submissions, pageId, fileId],
  );
  const visibleThreads = pageThreads.filter((thread) => !thread.resolved);
  const listedThreads = pageThreads.filter((thread) => thread.resolved === (filter === "resolved"));
  const active = pageThreads.find((thread) => thread.id === activeId);
  const canManageActive = Boolean(
    active &&
    !readOnly &&
    (canModerateThreads || viewerId === active.createdBy) &&
    !submissions.some(
      (item) => item.create && item.thread.id === active.id && item.kind !== "sent",
    ),
  );
  const point = draft ?? active ?? null;
  const width = viewport.current?.clientWidth ?? 0;
  const height = viewport.current?.clientHeight ?? 0;
  const popupX = point ? Math.max(12, Math.min(width - 332, point.x * view.zoom + view.x + 22)) : 0;
  const popupY = point
    ? Math.max(12, Math.min(height - 340, point.y * view.zoom + view.y + 22))
    : 0;

  useLayoutEffect(() => {
    if (
      scrollRequest.current &&
      active?.messages.some((message) => message.id === scrollRequest.current)
    ) {
      if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
      scrollRequest.current = null;
    }
  }, [activeId, active?.messages]);

  async function send(submission: Submission) {
    const message = submission.thread.messages[0];
    const work = (async () => {
      try {
        if (!submission.create) {
          const creation = creationRequests.current.get(submission.thread.id);
          if (creation && !(await creation) && creationRequests.current.has(submission.thread.id))
            throw new Error("Post the original comment before retrying this reply.");
        }
        const targetId =
          submissionsRef.current.find((item) => item.thread.messages[0].id === message.id)?.thread
            .id ?? submission.thread.id;
        const result = submission.create
          ? await addCommentThread({
              fileId: submission.fileId,
              threadId: targetId,
              messageId: message.id,
              x: submission.thread.x,
              y: submission.thread.y,
              pageId: submission.thread.pageId,
              body: message.body,
            })
          : await addCommentReply({
              fileId: submission.fileId,
              threadId: targetId,
              messageId: message.id,
              body: message.body,
            });
        if (result.kind === "error") throw new Error(result.error);
        if (result.kind === "created" && result.id !== submission.thread.id) {
          setSubmissions((current) =>
            current.map((item) =>
              item.thread.id !== submission.thread.id
                ? item
                : { ...item, thread: { ...item.thread, id: result.id } },
            ),
          );
          setActiveId((current) => (current === submission.thread.id ? result.id : current));
          if (focusedThread.current === submission.thread.id) focusedThread.current = result.id;
        }
        setSubmissions((current) =>
          current.map((item) =>
            item.thread.messages[0].id !== message.id
              ? item
              : {
                  ...item,
                  kind: "sent",
                  legacyReceipt: !result.message,
                  ackVersion: refreshVersion.current,
                  thread: {
                    ...item.thread,
                    createdBy: item.create
                      ? (result.message?.authorId ?? item.thread.createdBy)
                      : item.thread.createdBy,
                    messages: [result.message ?? message],
                  },
                },
          ),
        );
        // New receipts include the saved message; no list or thread refetch is needed to post.
        // Older servers can still reconcile via the existing bounded comment reads.
        if (!result.message) void refresh(result.kind === "created" ? result.id : targetId);
        return true;
      } catch (cause) {
        setSubmissions((current) =>
          current.map((item) =>
            item.thread.messages[0].id !== message.id
              ? item
              : {
                  ...item,
                  kind: "failed",
                  error: cause instanceof Error ? cause.message : "Could not post comment.",
                },
          ),
        );
        return false;
      }
    })();
    if (submission.create) creationRequests.current.set(submission.thread.id, work);
    const sent = await work;
    if (sent && creationRequests.current.get(submission.thread.id) === work) {
      creationRequests.current.delete(submission.thread.id);
    }
  }

  function post() {
    const text = bodyRef.current.trim();
    if (!text || readOnly || (!draft && !active)) return;
    const author = viewer ?? active?.messages.find((message) => message.authorId === viewerId);
    const message: CommentMessage = {
      id: crypto.randomUUID(),
      authorId: viewerId ?? "viewer",
      authorName: author && "name" in author ? author.name : (author?.authorName ?? "You"),
      authorImage: author && "image" in author ? author.image : (author?.authorImage ?? null),
      body: text,
      createdAt: new Date().toISOString(),
      reactions: [],
    };
    const thread: CommentThread = draft
      ? {
          id: crypto.randomUUID(),
          pageId,
          x: draft.x,
          y: draft.y,
          createdBy: message.authorId,
          resolved: false,
          messages: [message],
        }
      : { ...active!, messages: [message] };
    const submission: Submission = { fileId, thread, create: Boolean(draft), kind: "sending" };
    setSubmissions((current) => [...current, submission]);
    setBody("");
    setError("");
    scrollRequest.current = message.id;
    if (draft) {
      setActiveId(thread.id);
      focusedThread.current = thread.id;
      setDraft(null);
    }
    void send(submission);
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
      submissionsRef.current.some(
        (submission) => submission.thread.id === thread.id && submission.kind === "sending",
      ) ||
      readOnly ||
      !(canModerateThreads || viewerId === thread.createdBy)
    )
      return;
    const interaction = ++interactionRef.current;
    mutationRef.current = { thread, resolved };
    setSubmissions((current) =>
      current.flatMap((item) =>
        item.thread.id !== thread.id
          ? [item]
          : resolved !== null && item.kind === "failed"
            ? [{ ...item, thread: { ...item.thread, resolved } }]
            : [],
      ),
    );
    // Invalidate reads started before the optimistic mutation.
    refreshVersion.current++;
    setThreads((current) =>
      mergeCommentPages([current, [thread]]).flatMap((item) =>
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
          ? await removeCommentThread({ fileId, threadId: thread.id })
          : await changeCommentThreadStatus({ fileId, threadId: thread.id, resolved });
      if (result.kind === "error") throw new Error(result.error);
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
          className="absolute left-4 right-4 top-20 flex items-center justify-end gap-2 md:top-4"
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
              <span data-ph-public style={{ display: "contents" }}>
                Comments (
              </span>
              {pageThreads.length}
              <span data-ph-public style={{ display: "contents" }}>
                {nextCursor ? "+" : ""}
              </span>
              <span data-ph-public style={{ display: "contents" }}>
                )
              </span>
            </button>
          )}
          {toolbarControls && <div className="pointer-events-auto shrink-0">{toolbarControls}</div>}
          {(pageThreads.length > 0 || nextCursor) && listOpen && (
            <section
              data-ph-public-label
              id="comment-list"
              aria-label="Comments"
              className="pointer-events-auto absolute right-0 top-full mt-2 w-64 max-w-full rounded-lg border border-primary-grey/70 bg-surface p-2 shadow-lg"
            >
              <SelectMenu
                replayLabel
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
                  data-ph-public
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
        <h2 data-ph-public id="delete-comment-title" className="text-lg font-semibold">
          Delete thread?
        </h2>
        <p
          data-ph-public
          id="delete-comment-description"
          className="mt-3 text-sm text-secondary-ink"
        >
          This permanently deletes the comment and all replies.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            data-ph-public
            type="button"
            autoFocus
            onClick={() => deleteDialog.current?.close()}
            className="rounded-lg px-4 py-2 text-sm hover:bg-primary-grey/20"
          >
            Cancel
          </button>
          <button
            data-ph-public
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
          data-ph-public-label
          aria-label="Comment thread"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          className="pointer-events-auto absolute flex max-h-[min(24rem,calc(100%-1.5rem))] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-primary-grey/70 bg-surface shadow-xl"
          style={{ left: popupX, top: popupY }}
        >
          <div className="relative flex items-center justify-between gap-2 border-b border-primary-grey/70 px-3 py-2">
            <h2 data-ph-public className="text-sm font-semibold">
              {draft ? "New comment" : active?.resolved ? "Resolved comment" : "Comment thread"}
            </h2>
            <div className="flex items-center gap-2">
              {active && canManageActive && (
                <>
                  <button
                    data-ph-public
                    type="button"
                    disabled={changing || posting}
                    onClick={() => void changeThread(active, !active.resolved)}
                    className="text-xs hover:underline disabled:opacity-50"
                  >
                    {active?.resolved ? "Reopen" : "Resolve"}
                  </button>
                  <button
                    data-ph-public
                    data-ph-public-label
                    type="button"
                    aria-label="Thread options"
                    aria-expanded={optionsOpen}
                    disabled={changing || posting}
                    onClick={() => setOptionsOpen((open) => !open)}
                    className="flex size-7 items-center justify-center rounded text-secondary-ink hover:bg-primary-grey/20 disabled:opacity-50"
                  >
                    <Icon name="more" size={16} />
                  </button>
                </>
              )}
              <button
                data-ph-public
                data-ph-public-label
                type="button"
                aria-label="Close comments"
                onClick={() => {
                  interactionRef.current++;
                  setDraft(null);
                  setActiveId(null);
                  setOptionsOpen(false);
                  setError("");
                }}
                className="flex size-7 items-center justify-center rounded text-secondary-ink hover:bg-primary-grey/20"
              >
                <Icon name="xmark" size={16} />
              </button>
            </div>
            {optionsOpen && active && canManageActive && (
              <div className="absolute right-3 top-full z-10 rounded-lg border border-primary-grey/70 bg-surface p-1 shadow-lg">
                <button
                  data-ph-public
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
            <div ref={messageList} className="min-h-0 space-y-3 overflow-y-auto px-3 py-3">
              {active.messages.map((message) => {
                const submission = submissions.find(
                  (item) => item.thread.messages[0].id === message.id,
                );
                return (
                  <div key={message.id}>
                    <ThreadMessage
                      message={message}
                      fileId={fileId}
                      viewerId={submission && submission.kind !== "sent" ? null : viewerId}
                      reactionsAvailable={
                        reactionsAvailable && (!submission || submission.kind === "sent")
                      }
                      refresh={refresh}
                      readVersion={
                        confirmedRead.messageIds.has(message.id) ? confirmedRead.version : 0
                      }
                      latestReadVersion={latestReadVersion}
                    />
                    {submission?.kind === "sending" && <SendingStatus />}
                    {submission?.kind === "failed" && (
                      <div className="ml-9 mt-1 flex items-center gap-2 text-xs text-danger">
                        <p role="alert">{submission.error}</p>
                        <button
                          type="button"
                          className="shrink-0 underline"
                          onClick={() => {
                            if (
                              !submissionsRef.current.some(
                                (item) => item === submission && item.kind === "failed",
                              )
                            )
                              return;
                            setSubmissions((current) =>
                              current.map((item) =>
                                item === submission ? { ...item, kind: "sending" } : item,
                              ),
                            );
                            void send(submission);
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!readOnly && (
            <div className="border-t border-primary-grey/70 p-3">
              <textarea
                data-ph-public-label
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
                <span data-ph-public className="text-xs text-secondary-ink">
                  Enter to post · Shift+Enter for newline
                </span>
                <button
                  data-ph-public
                  type="button"
                  disabled={!body.trim()}
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
      {(error || loadError) &&
        !point &&
        notificationRoot &&
        createPortal(
          <EditorNotification
            message={error || loadError}
            onDismiss={() => {
              setError("");
              setLoadError("");
              viewport.current?.focus({ preventScroll: true });
            }}
          />,
          notificationRoot,
        )}
    </div>
  );
});
