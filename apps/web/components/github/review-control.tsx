"use client";

import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { Dialog } from "@/components/ui/dialog";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import type { DesignDocument } from "@/lib/design/document";
import type { Review, ReviewContext } from "@/lib/github/reviews";
import { DesignSnapshot } from "./design-snapshot";
import { SelectMenu } from "@/components/ui/select-menu";

type ReviewList = { ready: boolean; reviews: Omit<Review, "content">[] };
const button =
  "rounded-md border border-primary-grey/80 bg-surface px-2.5 py-1.5 text-xs hover:bg-primary-grey/20 disabled:opacity-40";
const input =
  "w-full rounded-md border border-primary-grey/80 bg-surface px-2.5 py-2 text-sm focus:outline-primary-orange";
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Could not complete the request.");
  return data as T;
}
const body = (value: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
export function ReviewControl({
  fileId,
  document,
  revision,
  selectedIds,
  initial,
  viewerId,
  disabled,
  canEdit = true,
  initialReviewId,
}: {
  fileId: string;
  document: DesignDocument;
  revision: number;
  selectedIds: string[];
  initial: ReviewList;
  viewerId: string;
  disabled: boolean;
  canEdit?: boolean;
  initialReviewId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const linkedInitialId = initial.reviews.some((item) => item.id === initialReviewId)
    ? (initialReviewId ?? null)
    : null;
  const [open, setOpen] = useState(Boolean(linkedInitialId));
  const [list, setList] = useState(initial);
  const [reviewId, setReviewId] = useState<string | null>(linkedInitialId);
  const [context, setContext] = useState<ReviewContext | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [frames, setFrames] = useState<string[]>([]);
  const [frameId, setFrameId] = useState("");
  const [captureId, setCaptureId] = useState("");
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [feedback, setFeedback] = useState("");
  const requestVersion = useRef(0);
  const liveReviewId = useRef(reviewId);
  const editing = useRef(false);
  const mutation = useRef(false);
  useEffect(() => {
    liveReviewId.current = reviewId;
    editing.current = Boolean(feedback || point || nodeId);
  }, [reviewId, feedback, point, nodeId]);
  const load = useCallback(async (id: string, background = false) => {
    const version = ++requestVersion.current;
    try {
      const next = await api<ReviewContext>(`/api/github/reviews/${id}`);
      if (
        version === requestVersion.current &&
        liveReviewId.current === id &&
        !(background && (editing.current || mutation.current))
      ) {
        setContext(next);
        if (!background) setError("");
      }
    } catch (e) {
      if (version === requestVersion.current && liveReviewId.current === id) {
        setContext(null);
        setError(e instanceof Error ? e.message : "Could not read review.");
      }
    }
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || !reviewId) return;
    void Promise.resolve().then(() => load(reviewId));
    const interval = window.setInterval(() => {
      if (window.document.visibilityState === "visible" && !editing.current && !mutation.current)
        void load(reviewId, true);
    }, 20000);
    return () => {
      window.clearInterval(interval);
    };
  }, [open, reviewId, load]);
  const review = context?.review;
  const activeFrame = review?.frameIds.includes(frameId) ? frameId : (review?.frameIds[0] ?? "");
  const availableCaptures =
    context?.captures.filter((capture) => capture.frameId === activeFrame) ?? [];
  const capture = availableCaptures.find((item) => item.id === captureId) ?? availableCaptures[0];
  function chooseReview(id: string | null) {
    requestVersion.current++;
    liveReviewId.current = id;
    setReviewId(id);
    setContext(null);
    setFrameId("");
    setCaptureId("");
    setNodeId(null);
    setPoint(null);
    setFeedback("");
    setError("");
  }
  async function mutate(operation: () => Promise<unknown>) {
    mutation.current = true;
    setBusy(true);
    setError("");
    requestVersion.current++;
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete the action.");
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  function show() {
    setFrames(
      document.nodes
        .filter(
          (node) =>
            node.type === "artboard" &&
            selectedIds.some((id) => {
              let item = document.nodes.find((candidate) => candidate.id === id);
              while (item && item.id !== node.id && item.parentId)
                item = document.nodes.find((candidate) => candidate.id === item!.parentId);
              return item?.id === node.id;
            }),
        )
        .map((node) => node.id),
    );
    setOpen(true);
    void api<ReviewList>(`/api/files/${encodeURIComponent(fileId)}/reviews`)
      .then(setList)
      .catch((e) => setError(e.message));
  }
  return (
    <>
      <button type="button" className={button} aria-haspopup="dialog" onClick={show}>
        Pull requests{list.reviews.length ? ` · ${list.reviews.length}` : ""}
      </button>
      <Dialog
        ref={dialog}
        aria-label="Pull request review"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        onKeyDown={(event) => event.stopPropagation()}
        size="wide"
        data-canvas-control
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <SelectMenu
            label="Linked pull request"
            disabled={busy}
            value={reviewId ?? ""}
            onChange={(value) => chooseReview(value || null)}
            options={[
              { value: "", label: canEdit ? "Link a pull request" : "Choose a pull request" },
              ...list.reviews.map((item) => ({
                value: item.id,
                label: `${item.repository} #${item.number} · Design r${item.revision}`,
              })),
            ]}
          />
          <button type="button" className={button} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        {!list.ready ? (
          <p className="text-sm">GitHub integration is awaiting its database migration.</p>
        ) : !reviewId ? (
          canEdit && (
            <form
              className="max-w-xl space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(async () => {
                  const linked = await api<{ reviewId: string }>(
                    `/api/files/${encodeURIComponent(fileId)}/reviews`,
                    body({ url, frameIds: frames, expectedRevision: revision }),
                  );
                  setList(
                    await api<ReviewList>(`/api/files/${encodeURIComponent(fileId)}/reviews`),
                  );
                  posthog.capture("pull_request_linked", { frame_count: frames.length });
                  chooseReview(linked.reviewId);
                  setUrl("");
                });
              }}
            >
              <label className="block text-xs">
                Pull request URL
                <input
                  required
                  type="url"
                  className={`${input} mt-1`}
                  placeholder="https://github.com/owner/repo/pull/123"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs">
                  Frames to review · Design revision {revision}
                </legend>
                {document.nodes
                  .filter((node) => node.type === "artboard")
                  .map((node) => (
                    <label key={node.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={frames.includes(node.id)}
                        onChange={(event) =>
                          setFrames((current) =>
                            event.target.checked
                              ? [...current, node.id]
                              : current.filter((id) => id !== node.id),
                          )
                        }
                      />
                      {node.name}
                    </label>
                  ))}
              </fieldset>
              <div className="flex items-center gap-4">
                <button
                  className={button}
                  disabled={!canEdit || busy || disabled || !frames.length}
                >
                  Link PR
                </button>
                <Link
                  prefetchOnIntent
                  href="/settings?tab=connectors&connector=github"
                  className="text-xs underline"
                >
                  GitHub connection settings
                </Link>
              </div>
            </form>
          )
        ) : context && review ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <a
                href={review.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                #{review.number} {review.title}
              </a>
              <span>{review.state}</span>
              <code className="text-xs">
                {review.branch} · {review.headSha.slice(0, 7)}
              </code>
              {context.previewUrl && (
                <a className="underline" href={context.previewUrl} target="_blank" rel="noreferrer">
                  Open preview
                </a>
              )}
              <button className={button} disabled={busy} onClick={() => void load(review.id)}>
                Refresh PR
              </button>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {context.checks === null ? (
                <span>Checks unavailable</span>
              ) : (
                context.checks.map((check, index) => (
                  <span key={`${check.name}-${index}`}>
                    {check.name}: {check.conclusion ?? check.status}
                  </span>
                ))
              )}
              {context.commitStatus && <span>Commit status: {context.commitStatus}</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              <SelectMenu
                label="Design frame"
                className="w-full"
                value={activeFrame}
                disabled={busy}
                onChange={(value) => {
                  setFrameId(value);
                  setCaptureId("");
                  setPoint(null);
                  setNodeId(null);
                }}
                options={review.frameIds.map((id) => ({
                  value: id,
                  label: review.content.nodes.find((node) => node.id === id)?.name ?? id,
                }))}
              />
              {availableCaptures.length > 0 && (
                <SelectMenu
                  label="Implementation capture"
                  className="w-full"
                  value={capture?.id ?? ""}
                  disabled={busy}
                  onChange={(value) => {
                    setCaptureId(value);
                    setPoint(null);
                  }}
                  options={availableCaptures.map((item) => ({
                    value: item.id,
                    label: `${item.sha.slice(0, 7)} · ${item.route} · ${item.width} × ${item.height}`,
                  }))}
                />
              )}
            </div>
            <div className="grid items-start gap-5 md:grid-cols-2">
              <div>
                <p className="mb-2 text-xs text-secondary-ink">
                  Design · pinned revision {review.revision}
                </p>
                <DesignSnapshot
                  reviewId={review.id}
                  content={review.content}
                  frameId={activeFrame}
                  selectedNode={nodeId}
                  onSelect={setNodeId}
                />
              </div>
              <div>
                <p className="mb-2 text-xs text-secondary-ink">
                  Implementation
                  {capture
                    ? ` · ${capture.sha.slice(0, 7)}${capture.sha !== review.headSha ? " · newer commit awaiting capture" : ""}`
                    : " · awaiting capture"}
                </p>
                {capture && (
                  <button
                    type="button"
                    aria-label="Mark a point on the implementation"
                    className="relative block w-full cursor-crosshair overflow-hidden rounded-md border border-primary-grey/70 bg-canvas"
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setPoint(
                        event.detail === 0
                          ? { x: 0.5, y: 0.5 }
                          : {
                              x: Math.max(
                                0,
                                Math.min(1, (event.clientX - bounds.left) / bounds.width),
                              ),
                              y: Math.max(
                                0,
                                Math.min(1, (event.clientY - bounds.top) / bounds.height),
                              ),
                            },
                      );
                    }}
                  >
                    <Image
                      unoptimized
                      src={`/api/github/reviews/${review.id}/captures/${capture.id}`}
                      alt={`Implementation at ${capture.sha.slice(0, 7)}`}
                      width={capture.width}
                      height={capture.height}
                      className="h-auto w-full"
                    />
                    {point && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-handle bg-primary-orange shadow"
                        style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                      />
                    )}
                  </button>
                )}
              </div>
            </div>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const reviewedCapture = capture;
                const selectedPoint = point;
                const text = feedback;
                void mutate(async () => {
                  await api(
                    `/api/github/reviews/${review.id}/feedback`,
                    body({
                      body: text,
                      sha: reviewedCapture?.sha ?? review.headSha,
                      ...(nodeId ? { nodeId } : {}),
                      ...(reviewedCapture ? { captureId: reviewedCapture.id } : {}),
                      ...(selectedPoint ? { point: selectedPoint } : {}),
                    }),
                  );
                  posthog.capture("review_feedback_added", {
                    has_design_layer: Boolean(nodeId),
                    has_implementation_point: Boolean(selectedPoint),
                  });
                  setFeedback("");
                  setPoint(null);
                  await load(review.id);
                });
              }}
            >
              <div className="text-xs">
                <span>Design layer</span>
                <SelectMenu
                  label="Feedback design layer"
                  className="mt-1"
                  value={nodeId ?? ""}
                  onChange={(value) => setNodeId(value || null)}
                  options={[
                    { value: "", label: "General feedback" },
                    ...review.content.nodes.map((node) => ({
                      value: node.id,
                      label: `${node.name}${node.sourcePath ? ` · ${node.sourcePath}` : ""}`,
                    })),
                  ]}
                />
              </div>
              <textarea
                aria-label="Visual feedback"
                required
                maxLength={2000}
                className={input}
                placeholder="Describe the change needed…"
                value={feedback}
                disabled={busy}
                onChange={(event) => setFeedback(event.target.value)}
              />
              <button className={button} disabled={busy || !feedback.trim()}>
                Add feedback
              </button>
            </form>
            {context.feedback.length > 0 && (
              <ul className="space-y-3">
                {context.feedback.map((item) => {
                  const originalCapture = context.captures.find(
                    (previous) => previous.id === item.captureId,
                  );
                  const fixCapture = context.captures.find(
                    (candidate) =>
                      candidate.sha === item.fixSha &&
                      (!originalCapture ||
                        (candidate.frameId === originalCapture.frameId &&
                          candidate.route === originalCapture.route &&
                          candidate.width === originalCapture.width &&
                          candidate.height === originalCapture.height)),
                  );
                  return (
                    <li
                      key={item.id}
                      className="rounded-lg border border-primary-grey/70 p-3 text-sm"
                    >
                      <div className="flex flex-wrap gap-2 text-xs text-secondary-ink">
                        <span>{item.authorName}</span>
                        <span>{item.status}</span>
                        <code>{item.sha.slice(0, 7)}</code>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap">{item.body}</p>
                      {item.response && (
                        <p className="mt-2 whitespace-pre-wrap text-secondary-ink">
                          {item.response} · Fix {item.fixSha?.slice(0, 7)}
                        </p>
                      )}
                      {item.authorId === viewerId && canEdit && (
                        <div className="mt-3 flex gap-2">
                          {item.githubCommentId ? (
                            <a
                              className="text-xs underline"
                              href={`${review.url}#issuecomment-${item.githubCommentId}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              GitHub comment
                            </a>
                          ) : (
                            <button
                              className={button}
                              disabled={busy}
                              onClick={() =>
                                void mutate(async () => {
                                  await api(
                                    `/api/github/reviews/${review.id}/feedback`,
                                    body({ action: "send", feedbackId: item.id }, "PATCH"),
                                  );
                                  await load(review.id);
                                })
                              }
                            >
                              Send to GitHub
                            </button>
                          )}
                          {item.status === "proposed" && fixCapture && (
                            <button
                              className={button}
                              disabled={busy}
                              onClick={() => {
                                setFrameId(fixCapture.frameId);
                                setCaptureId(fixCapture.id);
                                setPoint(null);
                              }}
                            >
                              View proposed fix
                            </button>
                          )}
                          {item.status === "proposed" &&
                            fixCapture &&
                            capture?.id === fixCapture.id && (
                              <button
                                className={button}
                                disabled={busy}
                                onClick={() =>
                                  void mutate(async () => {
                                    await api(
                                      `/api/github/reviews/${review.id}/feedback`,
                                      body(
                                        {
                                          action: "verify",
                                          feedbackId: item.id,
                                          captureId: fixCapture.id,
                                        },
                                        "PATCH",
                                      ),
                                    );
                                    await load(review.id);
                                  })
                                }
                              >
                                Verify fix
                              </button>
                            )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {context.comments && context.comments.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs">
                  GitHub discussion · {context.comments.length}
                </summary>
                <ul className="mt-3 space-y-3">
                  {context.comments.map((comment) => (
                    <li key={comment.id} className="text-sm">
                      <a
                        href={comment.html_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline"
                      >
                        {comment.user.login}
                      </a>
                      <p className="whitespace-pre-wrap">{comment.body}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : !error ? (
          <p role="status" className="text-sm text-secondary-ink">
            Loading review…
          </p>
        ) : null}
        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
