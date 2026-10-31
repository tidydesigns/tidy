import { memo, useState } from "react";
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
  independent = false,
}: {
  tasks: ThreadTask[];
  summaries: ReadonlyMap<string, ThreadSummary>;
  projectId: string;
  independent?: boolean;
  onOpenThread(projectId: string, threadId: string): void;
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
        <span className="agent-tasks-count">
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
          {tasks.map((task) => {
            const child = summaries.get(task.childThreadId);
            const name = child?.title || task.label;
            const state = taskPresentation(task, child);
            return (
              <div key={task.id}>
                <Button
                  className="agent-task"
                  disabled={!child}
                  onClick={() => onOpenThread(projectId, task.childThreadId)}
                  data-state={task.state}
                  data-kind={task.kind}
                  aria-label={`${name} · ${state.label}`}
                  title={
                    child
                      ? `${name} · ${state.label}${task.error ? ` · ${task.error}` : ""}`
                      : `${name} · ${state.label}${task.error ? ` · ${task.error}` : task.state === "queued" ? " — thread available when the agent starts" : ""}`
                  }
                >
                  <ModelProviderIcon harness={task.harness} size={15} />
                  <span className="agent-task-label">{name}</span>
                </Button>
                {task.error && (
                  <p className="agent-task-error" role="status">
                    {task.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
});
