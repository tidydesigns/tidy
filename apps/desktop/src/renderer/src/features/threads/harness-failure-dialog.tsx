import { harnessNames } from "../../../../shared/contracts/harness-updates";
import type { HarnessFailureKind } from "../../../../shared/contracts/harness-failure";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import type { DesktopAPI, ThreadSummary } from "../../../../shared/contracts/desktop";
import { describeHarnessFailure } from "../../../../shared/models/harness-failure";
import { ChatLink } from "../../components/chat-link";

type Failure = Pick<
  ThreadSummary,
  "id" | "projectId" | "title" | "harness" | "error" | "errorKind" | "revision"
>;

const failureColor = (kind: HarnessFailureKind) =>
  kind === "billing" || kind === "rate-limit"
    ? "text-(--desktop-status-warning)"
    : "text-(--desktop-status-danger)";

function FailureIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <circle cx="12" cy="16.5" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HarnessFailureSummary({
  error,
  kind,
  onDetails,
}: {
  error: string;
  kind?: HarnessFailureKind;
  onDetails(): void;
}) {
  const failure = describeHarnessFailure(error, kind);
  return (
    <div className="py-2">
      <Button
        className={`group flex w-fit max-w-full cursor-pointer items-center gap-2.5 rounded border-0 bg-transparent p-0 text-left text-[13px] leading-5 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-ink [&>svg]:shrink-0 ${failureColor(failure.kind)}`}
        onClick={onDetails}
      >
        <FailureIcon />
        <span>{failure.title}</span>
        <span className="ml-0.5 shrink-0 text-[11px] font-normal text-muted-ink group-hover:text-ink">
          Details <span aria-hidden="true">›</span>
        </span>
      </Button>
      <p className="mt-[5px] ml-[26px] max-w-[54ch] text-[13px] leading-5 text-secondary-ink">
        {failure.guidance}
      </p>
    </div>
  );
}

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
  const failure = describeHarnessFailure(thread.error ?? "", thread.errorKind);
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
      className="max-w-[420px] rounded-[10px] shadow-[0_12px_48px_#0002,0_2px_6px_#0001]"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={onClose}
    >
      <div className="p-5">
        <div className="flex items-start gap-2.5">
          <span className={`shrink-0 pt-0.5 ${failureColor(failure.kind)}`}>
            <FailureIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className={`text-sm leading-5 font-medium ${failureColor(failure.kind)}`}
            >
              {failure.title}
            </h2>
            <p
              className="mt-[3px] truncate text-[11px] leading-4 text-muted-ink"
              title={thread.title}
            >
              {harnessNames[thread.harness]}
              <span aria-hidden="true"> · </span>
              {thread.title}
            </p>
          </div>
          <Button
            ref={dismiss}
            autoFocus
            className="-mt-[3px] -mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent p-0 text-muted-ink hover:bg-hover-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-ink active:scale-97"
            aria-label="Dismiss error"
            onClick={() => dialog.current?.close()}
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </Button>
        </div>
        <p id={descriptionId} className="mt-3.5 ml-[26px] text-[13px] leading-5 text-secondary-ink">
          {failure.guidance}
        </p>
        {failure.kind === "policy" && failure.daybreak && (
          <p className="mt-2.5 ml-[26px] text-[13px] leading-5 text-secondary-ink [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-[3px]">
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
        <details className="mt-3.5 ml-[26px] text-xs leading-[18px]">
          <summary className="w-fit cursor-pointer rounded-xs text-muted-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border">
            Error details
          </summary>
          <pre className="mt-2.5 max-h-[180px] overflow-auto text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-secondary-ink [font-family:inherit] select-text">
            {thread.error || "The harness stopped unexpectedly."}
          </pre>
        </details>
      </div>
    </Dialog>
  );
}

export function HarnessFailureNotices({ api }: { api?: DesktopAPI }) {
  const [queue, setQueue] = useState<Failure[]>([]);
  useEffect(() => {
    setQueue([]);
    const seen = new Map<string, { revision: number; status: ThreadSummary["status"] }>();
    return api?.onEvent((event) => {
      if (event.type === "designs") return;
      const thread = event.type === "thread-patch" ? event.summary : event.thread;
      const previous = seen.get(thread.id);
      if (previous && previous.revision > thread.revision) return;
      seen.set(thread.id, { revision: thread.revision, status: thread.status });
      if (thread.status !== "failed") {
        if (previous?.status !== "failed") return;
        setQueue((current) =>
          current.some((item) => item.id === thread.id)
            ? current.filter((item) => item.id !== thread.id)
            : current,
        );
        return;
      }
      if (previous?.status !== "running") return;
      const { id, projectId, revision, title, harness, error, errorKind } = thread;
      const notice: Failure = { id, projectId, revision, title, harness, error, errorKind };
      setQueue((current) => [...current, notice]);
    });
  }, [api]);
  const thread = queue[0];
  return thread && api ? (
    <HarnessFailureDialog
      key={`${thread.id}:${thread.revision}`}
      thread={thread}
      api={api}
      onClose={() => setQueue((current) => current.filter((item) => item !== thread))}
    />
  ) : null;
}
