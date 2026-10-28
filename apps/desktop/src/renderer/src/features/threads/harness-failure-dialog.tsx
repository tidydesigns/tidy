import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import type { DesktopAPI, ThreadSummary } from "../../../../shared/contracts/desktop";
import { describeHarnessFailure } from "../../../../shared/models/harness-failure";
import { ChatLink } from "../../components/chat-link";

type Failure = Pick<ThreadSummary, "id" | "projectId" | "title" | "harness" | "error">;

export function HarnessFailureDialog({
  thread,
  api,
  onClose,
}: {
  thread: Failure;
  api: DesktopAPI;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const failure = describeHarnessFailure(thread.error ?? "");
  useEffect(() => {
    dialog.current?.showModal();
    dismiss.current?.focus({ preventScroll: true });
  }, []);
  return (
    <Dialog
      ref={dialog}
      role="alertdialog"
      size="md"
      padded={false}
      className="harness-failure-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={onClose}
    >
      <div className="harness-failure-body">
        <div className="harness-failure-heading">
          <span className="harness-failure-icon" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5" />
              <circle cx="12" cy="16.5" r=".7" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 id={titleId}>{failure.title}</h2>
            <p className="harness-failure-context" title={thread.title}>
              {thread.harness === "codex" ? "Codex" : "Claude Code"}
              <span aria-hidden="true"> · </span>
              {thread.title}
            </p>
          </div>
        </div>
        <p id={descriptionId} className="harness-failure-guidance">
          {failure.guidance}
        </p>
        {failure.kind === "policy" && failure.daybreak && (
          <p className="harness-failure-access">
            For authorized security work,{" "}
            <ChatLink
              api={api}
              projectId={thread.projectId}
              href="https://platform.openai.com/settings/organization/status-and-access"
            >
              request Daybreak access ↗
            </ChatLink>
            .
          </p>
        )}
        <details className="harness-failure-details">
          <summary>Error details</summary>
          <pre>{thread.error || "The harness stopped unexpectedly."}</pre>
        </details>
      </div>
      <div className="harness-failure-footer">
        <span>Your conversation is preserved.</span>
        <Button
          ref={dismiss}
          autoFocus
          className="harness-failure-dismiss"
          onClick={() => dialog.current?.close()}
        >
          Dismiss
        </Button>
      </div>
    </Dialog>
  );
}

export function HarnessFailureNotices({ api }: { api?: DesktopAPI }) {
  const [queue, setQueue] = useState<Failure[]>([]);
  useEffect(() => {
    setQueue([]);
    const failed = new Set<string>();
    const revisions = new Map<string, number>();
    return api?.onEvent((event) => {
      if (event.type === "designs") return;
      const thread = event.type === "thread-patch" ? event.summary : event.thread;
      if ((revisions.get(thread.id) ?? -1) > thread.revision) return;
      revisions.set(thread.id, thread.revision);
      if (thread.status !== "failed") {
        if (!failed.delete(thread.id)) return;
        setQueue((current) =>
          current.some((item) => item.id === thread.id)
            ? current.filter((item) => item.id !== thread.id)
            : current,
        );
        return;
      }
      if (failed.has(thread.id)) return;
      failed.add(thread.id);
      setQueue((current) => [...current, thread]);
    });
  }, [api]);
  const thread = queue[0];
  return thread && api ? (
    <HarnessFailureDialog
      key={thread.id}
      thread={thread}
      api={api}
      onClose={() => setQueue((current) => current.filter((item) => item.id !== thread.id))}
    />
  ) : null;
}
