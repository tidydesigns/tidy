import { memo, useEffect, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { Message, Thread } from "../../../../shared/contracts/desktop";
import { formatElapsedTime } from "./thread-time";

const matrixRing = [1, 2, 7, 11, 14, 13, 8, 4];

function Elapsed({
  startedAt,
  endedAt,
  live,
}: {
  startedAt: string;
  endedAt?: string;
  live: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live || endedAt) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (document.hidden) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [live, startedAt, endedAt]);
  return (
    <span>{formatElapsedTime((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt))}</span>
  );
}

export const TurnStatus = memo(function TurnStatus({
  message,
  thread,
  visible,
  disclosure,
}: {
  message: Message;
  thread?: Thread;
  visible: boolean;
  disclosure?: { expanded: boolean; controls: string; toggle: (instant: boolean) => void };
}) {
  const running = thread?.status === "running";
  if (!message.turn && !running && !disclosure) return null;
  const waiting = running && Boolean(thread?.pendingApprovals?.length);
  const startedAt = message.turn?.startedAt ?? thread?.updatedAt;
  const endedAt = message.turn?.endedAt;
  const timed = running || Boolean(endedAt);
  const label = running
    ? "Working for"
    : !thread || thread.status === "completed"
      ? "Worked for"
      : thread.status === "failed"
        ? "Failed after"
        : thread.status === "interrupted"
          ? "Interrupted after"
          : "Stopped after";
  const phase = !running
    ? undefined
    : waiting
      ? "Waiting for permission"
      : thread?.activity === "Starting"
        ? "Starting session"
        : thread?.activity === "Thinking"
          ? "Thinking"
          : thread?.activity === "Stopping"
            ? "Stopping"
            : undefined;
  const heading = (
    <div className="turn-status-heading" data-running={running ? "" : undefined}>
      {running && (
        <span className="turn-status-icon" aria-hidden="true">
          <span className="working-matrix">
            {Array.from({ length: 16 }, (_, index) => {
              const step = matrixRing.indexOf(index);
              return (
                <i
                  key={index}
                  style={{
                    animationDelay: `${step * 150 - 1200}ms`,
                    animationName: step < 0 ? "none" : undefined,
                  }}
                />
              );
            })}
          </span>
        </span>
      )}
      <span
        className="turn-status-time"
        role="timer"
        aria-live="off"
        aria-hidden={Boolean(disclosure) && (timed || !message.turn)}
      >
        {timed && startedAt ? (
          <>
            {label} <Elapsed startedAt={startedAt} endedAt={endedAt} live={running && visible} />
          </>
        ) : message.turn ? (
          "Interrupted"
        ) : (
          "Work details"
        )}
      </span>
      {disclosure && (
        <span className="turn-work-chevron" aria-hidden="true">
          ›
        </span>
      )}
      <span className="turn-status-phase" role="status">
        {phase}
      </span>
      {disclosure && (
        <Button
          type="button"
          className="turn-work-summary"
          aria-expanded={disclosure.expanded}
          aria-controls={disclosure.controls}
          aria-label={
            endedAt && startedAt
              ? `${label} ${formatElapsedTime(Date.parse(endedAt) - Date.parse(startedAt))}`
              : "Work details"
          }
          onClick={(event) => disclosure.toggle(event.detail === 0)}
        />
      )}
    </div>
  );
  return (
    <div
      className="turn-status"
      data-active={
        running && !waiting && thread?.activity !== "Stopping" && visible ? "" : undefined
      }
    >
      {heading}
    </div>
  );
});
