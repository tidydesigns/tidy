import { memo, useMemo, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";
import type { ThreadTask } from "../../../../shared/contracts/thread-tasks";
import { ModelProviderIcon } from "../harnesses/model-provider-icon";
import "./agent-tasks.css";

export function taskPresentation(task: ThreadTask, child?: ThreadSummary) {
  switch (task.state) {
    case "queued":
      return { label: "Queued", tone: "muted" };
    case "running":
      return child?.pendingApprovalCount
        ? { label: "Needs approval", tone: "attention" }
        : { label: "Working", tone: "active" };
    case "cancel_requested":
      return { label: "Stopping", tone: "attention" };
    case "completed":
      return { label: "Reported complete", tone: "complete" };
    case "failed":
      return { label: "Failed", tone: "attention" };
    case "cancelled":
      return { label: "Stopped", tone: "muted" };
    case "interrupted":
      return { label: "Interrupted", tone: "attention" };
  }
}

function taskDestinations(tasks: ThreadTask[]) {
  const priority = (task: ThreadTask) =>
    task.state === "running"
      ? 3
      : task.state === "cancel_requested"
        ? 2
        : task.state === "queued"
          ? 1
          : 0;
  const destinations = new Map<string, ThreadTask>();
  const pending = new Map<string, ThreadTask[]>();
  for (const task of tasks) {
    if (task.state === "queued" || task.state === "cancel_requested") {
      const queue = pending.get(task.childThreadId) ?? [];
      queue.push(task);
      pending.set(task.childThreadId, queue);
    }
    const previous = destinations.get(task.childThreadId);
    if (
      !previous ||
      priority(task) > priority(previous) ||
      (priority(task) === priority(previous) &&
        (task.createdAt > previous.createdAt ||
          (task.createdAt === previous.createdAt && task.sequence > previous.sequence)))
    )
      destinations.set(task.childThreadId, task);
  }
  return Array.from(destinations.values(), (task) => ({
    task,
    queued: (pending.get(task.childThreadId) ?? []).filter((queued) => queued.id !== task.id),
  }));
}

export const AgentTasks = memo(function AgentTasks(props: {
  tasks: ThreadTask[];
  summaries: ReadonlyMap<string, ThreadSummary>;
  projectId: string;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
}) {
  const { agents, threads } = useMemo(
    () => ({
      agents: taskDestinations(props.tasks.filter((task) => task.kind !== "message")),
      threads: taskDestinations(props.tasks.filter((task) => task.kind === "message")),
    }),
    [props.tasks],
  );
  return (
    <>
      {agents.length > 0 && <TaskLinks {...props} destinations={agents} />}
      {threads.length > 0 && <TaskLinks {...props} destinations={threads} independent />}
    </>
  );
});

const TaskLinks = memo(function TaskLinks({
  destinations,
  summaries,
  projectId,
  onOpenThread,
  onCancel,
  independent = false,
}: {
  destinations: ReturnType<typeof taskDestinations>;
  summaries: ReadonlyMap<string, ThreadSummary>;
  projectId: string;
  independent?: boolean;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
}) {
  const active = destinations.filter(({ task }) =>
    ["queued", "running", "cancel_requested"].includes(task.state),
  ).length;
  const attention = destinations.some(
    ({ task }) =>
      task.state === "failed" ||
      task.state === "interrupted" ||
      (task.state === "running" && summaries.get(task.childThreadId)?.pendingApprovalCount),
  );
  const [expanded, setExpanded] = useState(Boolean(active || attention));
  return (
    <details
      className="agent-tasks"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="agent-tasks-chevron" aria-hidden="true">
          ›
        </span>
        <span>
          {destinations.length}{" "}
          {independent
            ? destinations.length === 1
              ? "thread"
              : "threads"
            : destinations.length === 1
              ? "agent"
              : "agents"}
        </span>
        <span className="agent-tasks-count" role="status" aria-live="polite" aria-atomic="true">
          {destinations.some(
            ({ task }) =>
              task.state === "running" && summaries.get(task.childThreadId)?.pendingApprovalCount,
          )
            ? "Needs approval"
            : attention
              ? "Needs attention"
              : active
                ? `${active} active`
                : "Finished"}
        </span>
      </summary>
      {expanded && (
        <div className="agent-task-list">
          {destinations.map(({ task, queued }) => (
            <div key={task.childThreadId}>
              <TaskRow
                key={task.id}
                task={task}
                child={summaries.get(task.childThreadId)}
                projectId={projectId}
                onOpenThread={onOpenThread}
                onCancel={onCancel}
              />
              {queued.length > 0 && (
                <QueuedAssignments
                  tasks={queued}
                  destinationName={summaries.get(task.childThreadId)?.title || task.label}
                  projectId={projectId}
                  onOpenThread={onOpenThread}
                  onCancel={onCancel}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
});

const QueuedAssignments = memo(function QueuedAssignments({
  tasks,
  destinationName,
  projectId,
  onOpenThread,
  onCancel,
}: {
  tasks: ThreadTask[];
  destinationName: string;
  projectId: string;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
}) {
  return (
    <details className="agent-task-queue">
      <summary
        aria-label={`${tasks.length} queued ${tasks.length === 1 ? "assignment" : "assignments"} for ${destinationName}`}
      >
        <span aria-hidden="true" className="agent-tasks-chevron">
          ›
        </span>
        <span role="status" aria-live="polite" aria-atomic="true">
          {tasks.length} queued {tasks.length === 1 ? "assignment" : "assignments"}
        </span>
      </summary>
      <div className="agent-task-queue-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            projectId={projectId}
            onOpenThread={onOpenThread}
            onCancel={onCancel}
            queued
          />
        ))}
      </div>
    </details>
  );
});

const TaskRow = memo(function TaskRow({
  task,
  child,
  projectId,
  onOpenThread,
  onCancel,
  queued = false,
}: {
  task: ThreadTask;
  child?: ThreadSummary;
  projectId: string;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
  queued?: boolean;
}) {
  const [cancellation, setCancellation] = useState<"idle" | "pending" | "accepted" | "failed">(
    "idle",
  );
  const pending = useRef(false);
  const active = ["queued", "running", "cancel_requested"].includes(task.state);
  const stopping =
    active &&
    (task.state === "cancel_requested" ||
      cancellation === "pending" ||
      cancellation === "accepted");
  const canCancel = task.state === "queued" || task.state === "running";
  const failed = canCancel && !stopping && cancellation === "failed";
  const state = stopping ? { label: "Stopping", tone: "attention" } : taskPresentation(task, child);
  const name = queued ? task.label : child?.title || task.label;
  const label = `${name} · ${state.label}`;
  const exceptional =
    stopping ||
    (task.state !== "completed" && (task.state !== "running" || child?.pendingApprovalCount));
  async function cancel() {
    if (!onCancel || pending.current || stopping || !canCancel) return;
    pending.current = true;
    setCancellation("pending");
    try {
      await onCancel(projectId, task.id);
      setCancellation("accepted");
    } catch {
      setCancellation("failed");
    } finally {
      pending.current = false;
    }
  }
  return (
    <div
      className="agent-task-row"
      role="group"
      tabIndex={!child ? 0 : undefined}
      aria-label={!child ? label : undefined}
    >
      <div className="agent-task-controls">
        {queued ? (
          <div className="agent-queued-task">
            <span className="agent-task-label" title={name}>
              {name}
            </span>
            <span className="agent-task-state" data-tone={state.tone} aria-hidden="true">
              {state.label}
            </span>
          </div>
        ) : (
          <Button
            className="agent-task"
            disabled={!child}
            onClick={() => onOpenThread(projectId, task.childThreadId)}
            data-state={task.state}
            data-kind={task.kind}
            aria-label={label}
            title={`${label}${task.error ? ` · ${task.error}` : !child && task.state === "queued" ? " — thread available when the agent starts" : ""}`}
          >
            <ModelProviderIcon harness={task.harness} size={15} />
            <span className="agent-task-label">{name}</span>
            {exceptional ? (
              <span className="agent-task-state" data-tone={state.tone} aria-hidden="true">
                {state.label}
              </span>
            ) : null}
          </Button>
        )}
        {onCancel && active && (
          <Button
            className="agent-task-stop"
            aria-label={failed ? `Retry stopping ${name}` : `Stop ${name}`}
            disabled={stopping}
            onClick={() => void cancel()}
          >
            {failed ? "Retry" : "Stop"}
          </Button>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {label}
      </span>
      {task.error && (
        <p className="agent-task-error" role="status">
          {task.error}
        </p>
      )}
      {failed && (
        <p className="agent-task-error" role="alert">
          Could not stop {name}. Try again.
        </p>
      )}
    </div>
  );
});
