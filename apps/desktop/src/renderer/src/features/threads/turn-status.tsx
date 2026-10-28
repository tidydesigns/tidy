import { memo, useEffect, useState } from "react";
import type { Message, Thread } from "../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../shared/contracts/tool-activity";
import { ToolActivityGroup, type ActivityPhase } from "./tool-activity";
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
  activities,
}: {
  message: Message;
  thread?: Thread;
  visible: boolean;
  activities: ToolActivity[];
}) {
  const running = thread?.status === "running";
  if (!message.turn && !running && !activities.length) return null;
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
  const phase: ActivityPhase | undefined = !running
    ? undefined
    : waiting
      ? "waiting"
      : thread?.activity === "Starting"
        ? "starting"
        : thread?.activity === "Thinking"
          ? "thinking"
          : thread?.activity === "Replying"
            ? "replying"
            : thread?.activity === "Stopping"
              ? "stopping"
              : "working";
  return (
    <div className="turn-status" data-active={running && !waiting && visible ? "" : undefined}>
      {(message.turn || running) && (
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
          <span className="turn-status-time" role="timer" aria-live="off">
            {timed && startedAt ? (
              <>
                {label}{" "}
                <Elapsed startedAt={startedAt} endedAt={endedAt} live={running && visible} />
              </>
            ) : (
              "Interrupted"
            )}
          </span>
        </div>
      )}
      <ToolActivityGroup activities={activities} visible={visible} phase={phase} />
    </div>
  );
});
