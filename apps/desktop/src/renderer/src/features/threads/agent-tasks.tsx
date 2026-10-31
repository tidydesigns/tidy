import { memo, useRef, useState } from "react";
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
    task.state === "running" || task.state === "cancel_requested"
      ? 2
      : task.state === "queued"
        ? 1
        : 0;
  const destinations = new Map<string, ThreadTask>();
  for (const task of tasks) {
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
  return [...destinations.values()];
}

export const AgentTasks = memo(function AgentTasks(props: {
  tasks: ThreadTask[];
  summaries: ReadonlyMap<string, ThreadSummary>;
  projectId: string;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
}) {
  const agents = taskDestinations(props.tasks.filter((task) => task.kind !== "message"));
  const threads = taskDestinations(props.tasks.filter((task) => task.kind === "message"));
  return (
    <>
      {agents.length > 0 && <TaskLinks {...props} tasks={agents} />}
      {threads.length > 0 && <TaskLinks {...props} tasks={threads} independent />}
    </>
  );
});

const TaskLinks = memo(function TaskLinks({
  tasks,
  summaries,
  projectId,
  onOpenThread,
  onCancel,
  independent = false,
}: {
  tasks: ThreadTask[];
  summaries: ReadonlyMap<string, ThreadSummary>;
  projectId: string;
  independent?: boolean;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
}) {
  const active = tasks.filter((task) =>
    ["queued", "running", "cancel_requested"].includes(task.state),
  ).length;
  const attention = tasks.some(
    (task) =>
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
          {tasks.length}{" "}
          {independent
            ? tasks.length === 1
              ? "thread"
              : "threads"
            : tasks.length === 1
              ? "agent"
              : "agents"}
        </span>
        <span className="agent-tasks-count" role="status" aria-live="polite" aria-atomic="true">
          {tasks.some(
            (task) =>
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
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              child={summaries.get(task.childThreadId)}
              projectId={projectId}
              onOpenThread={onOpenThread}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}
    </details>
  );
});

const TaskRow = memo(function TaskRow({
  task,
  child,
  projectId,
  onOpenThread,
  onCancel,
}: {
  task: ThreadTask;
  child?: ThreadSummary;
  projectId: string;
  onOpenThread(projectId: string, threadId: string): void;
  onCancel?(projectId: string, taskId: string): Promise<void>;
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
  const name = child?.title || task.label;
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
