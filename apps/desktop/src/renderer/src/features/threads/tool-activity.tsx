import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toolStatusLabel, type ToolActivity } from "../../../../shared/contracts/tool-activity";
import { toolTextPreview } from "./tool-text";
import { formatElapsedTime } from "./thread-time";
function elapsed(tool: ToolActivity, now: number) {
  if (tool.status === "interrupted" && !tool.endedAt) return undefined;
  return formatElapsedTime(
    (tool.endedAt ? Date.parse(tool.endedAt) : now) - Date.parse(tool.startedAt),
  );
}
export type ActivityPhase =
  | "starting"
  | "thinking"
  | "working"
  | "replying"
  | "waiting"
  | "stopping";
const phaseLabels: Record<ActivityPhase, string> = {
  starting: "Starting session",
  thinking: "Thinking",
  working: "Working",
  replying: "Writing response",
  waiting: "Waiting for permission",
  stopping: "Stopping",
};

function ToolIcon({ kind }: { kind: ToolActivity["kind"] | "thinking" | "history" }) {
  if (kind === "thinking") {
    return (
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g transform="translate(3 4) scale(.75)">
          <path d="M8 15c0-2-3-3-3-6a7 7 0 0 1 14 0c0 3-3 4-3 6v2H8Z" />
          <path d="M9 20h6m-5 2h4m-5-12 3 3 3-3m-3 3v4" />
        </g>
      </svg>
    );
  }
  const path =
    kind === "history"
      ? "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"
      : kind === "search"
        ? "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6"
        : kind === "edit"
          ? "m4 16 12-12 4 4L8 20H4v-4Zm10-10 4 4"
          : kind === "read"
            ? "M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6"
            : kind === "test"
              ? "M8 3h8M10 3v7L4 20h16l-6-10V3M7 15h10"
              : "m5 5 6 7-6 7m8 0h7";
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const ToolText = memo(function ToolText({
  text,
  label,
  className,
}: {
  text: string;
  label: "command" | "input" | "output";
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preview = useMemo(() => toolTextPreview(text), [text]);
  const shortened = preview.length < text.length;
  return (
    <div className="tool-detail-section">
      <pre id={id} className={className} aria-label={label}>
        {expanded || !shortened ? text : `${preview}\n…`}
      </pre>
      {shortened && (
        <button
          type="button"
          className="tool-detail-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show full ${label}`}
        </button>
      )}
    </div>
  );
});
const ToolRow = memo(function ToolRow({ tool, now }: { tool: ToolActivity; now: number }) {
  const label = elapsed(tool, now);
  const [open, setOpen] = useState(false);
  const command = tool.kind === "command" || tool.kind === "test";
  const showInput =
    tool.input &&
    !(tool.input === tool.title && !tool.input.includes("\n") && !tool.inputTruncated);
  return (
    <details
      className={`tool-call ${tool.parentToolId ? "tool-call-nested" : ""}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="activity-icon">
          <ToolIcon kind={tool.kind} />
        </span>
        {command && (
          <span className="tool-call-verb">
            {tool.status === "running"
              ? "Running"
              : tool.status === "completed" || tool.status === "failed"
                ? "Ran"
                : toolStatusLabel[tool.status]}
          </span>
        )}
        {command ? (
          <code className="tool-call-title" title={tool.title}>
            {tool.title}
          </code>
        ) : (
          <span className="tool-call-title" title={tool.title}>
            {tool.title}
          </span>
        )}
        {(tool.status === "failed" ||
          (!command && tool.status !== "completed") ||
          (tool.exitCode !== undefined && tool.exitCode !== 0)) && (
          <span className={`tool-status tool-status-${tool.status}`}>
            {toolStatusLabel[tool.status]}
            {tool.exitCode !== undefined && tool.exitCode !== 0 && ` · exit ${tool.exitCode}`}
          </span>
        )}
        {label && <span className="tool-duration">{label}</span>}
        <span className="activity-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      {open && (
        <div className="tool-call-details">
          {tool.files && tool.files.length > 0 && (
            <ul className="tool-files" aria-label="File changes">
              {tool.files.map((file, index) => (
                <li key={index}>
                  <span>{file.kind.charAt(0).toUpperCase() + file.kind.slice(1)}</span>
                  <code>{file.path}</code>
                </li>
              ))}
            </ul>
          )}
          {showInput && tool.input && (
            <ToolText
              text={tool.input}
              label={command ? "command" : "input"}
              className="tool-input"
            />
          )}
          {tool.inputTruncated && <small className="tool-truncation-notice">Input shortened</small>}
          {tool.output ? (
            <>
              <ToolText text={tool.output} label="output" className="tool-output" />
              {tool.outputTruncated && (
                <small className="tool-truncation-notice">Earlier output omitted</small>
              )}
            </>
          ) : (
            !tool.files?.length && (
              <p className="tool-empty-output">
                {tool.status === "running" ? "Waiting for output…" : "No text output"}
              </p>
            )
          )}
        </div>
      )}
    </details>
  );
});
export const ToolActivityGroup = memo(
  function ToolActivityGroup({
    activities,
    visible,
    phase,
  }: {
    activities: ToolActivity[];
    visible: boolean;
    phase?: ActivityPhase;
  }) {
    const [now, setNow] = useState(Date.now);
    const [revealed, setRevealed] = useState(false);
    const group = useRef<HTMLDetailsElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const active = activities.filter((tool) => tool.status === "running");
    const running = active.length > 0;
    useLayoutEffect(() => {
      const element = group.current;
      if (!running || !visible || !element) return;
      let timer: ReturnType<typeof setInterval> | undefined;
      const syncClock = () => {
        clearInterval(timer);
        if (!element.open || document.hidden) return;
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 1000);
      };
      element.addEventListener("toggle", syncClock);
      document.addEventListener("visibilitychange", syncClock);
      syncClock();
      return () => {
        clearInterval(timer);
        element.removeEventListener("toggle", syncClock);
        document.removeEventListener("visibilitychange", syncClock);
      };
    }, [running, visible]);
    useLayoutEffect(() => {
      if (visible && group.current?.open && following.current && list.current)
        list.current.scrollTop = list.current.scrollHeight;
    }, [activities.length, revealed, visible]);
    if (!activities.length && !phase) return null;
    const current = active.at(-1);
    const waiting = phase === "waiting" || phase === "stopping";
    const thinking = phase === "thinking" && !current;
    const showPhase =
      phase && (waiting || (!current && (phase !== "replying" || !activities.length)));
    const live = !waiting && Boolean(current || showPhase);
    const label = showPhase
      ? phaseLabels[phase]
      : (current?.title ?? `${activities.length} ${activities.length === 1 ? "step" : "steps"}`);
    const command = !showPhase && (current?.kind === "command" || current?.kind === "test");
    const line = (
      <>
        <span className="activity-summary-content" data-live={live ? "" : undefined}>
          <span className="activity-icon">
            <ToolIcon
              kind={thinking ? "thinking" : !waiting && current ? current.kind : "history"}
            />
          </span>
          {command && <span className="tool-call-verb">Running</span>}
          <span
            className="activity-summary-title"
            data-command={command ? "" : undefined}
            title={label}
          >
            <span className="activity-summary-text">{label}</span>
          </span>
        </span>
        {activities.length > 0 && (showPhase || current) && (
          <span className="activity-count">
            {activities.length} {activities.length === 1 ? "step" : "steps"}
          </span>
        )}
      </>
    );
    if (!activities.length)
      return (
        <div className="activity-row" role="status">
          {line}
        </div>
      );
    return (
      <details
        className="tool-activity-group"
        ref={group}
        onToggle={(event) => {
          if (event.target === event.currentTarget && event.currentTarget.open) setRevealed(true);
        }}
      >
        <summary
          onClick={() => setRevealed(true)}
          aria-label={`Tool activity, ${activities.length} ${activities.length === 1 ? "step" : "steps"}${running ? ", running" : ""}`}
        >
          {line}
          <span className="activity-chevron" aria-hidden="true">
            ›
          </span>
        </summary>
        {revealed && (
          <div
            className="tool-activity-list"
            ref={list}
            onClickCapture={() => {
              following.current = false;
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current =
                element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
            }}
          >
            {activities.map((tool) => (
              <ToolRow key={tool.id} tool={tool} now={tool.endedAt ? 0 : now} />
            ))}
          </div>
        )}
      </details>
    );
  },
  (previous, next) =>
    previous.visible === next.visible &&
    previous.phase === next.phase &&
    previous.activities.length === next.activities.length &&
    previous.activities.every((tool, index) => tool === next.activities[index]),
);
