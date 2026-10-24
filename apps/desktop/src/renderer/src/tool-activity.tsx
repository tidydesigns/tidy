import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toolStatusLabel, type ToolActivity } from "../../shared/tool-activity";
function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
function elapsed(tool: ToolActivity, now: number) {
  if (tool.status === "interrupted" && !tool.endedAt) return undefined;
  return duration((tool.endedAt ? Date.parse(tool.endedAt) : now) - Date.parse(tool.startedAt));
}
function ToolIcon({ kind }: { kind: ToolActivity["kind"] }) {
  const path =
    kind === "search"
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
  const preview = useMemo(() => text.split("\n").slice(0, 4).join("\n").slice(0, 480), [text]);
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
        <span className="activity-chevron" aria-hidden="true">
          ›
        </span>
        <ToolIcon kind={tool.kind} />
        <span className="tool-call-title" title={tool.title}>
          {open && command && showInput ? tool.toolName : tool.title}
        </span>
        {(tool.status !== "completed" || (tool.exitCode !== undefined && tool.exitCode !== 0)) && (
          <span className={`tool-status tool-status-${tool.status}`}>
            {toolStatusLabel[tool.status]}
            {tool.exitCode !== undefined && tool.exitCode !== 0 && ` · exit ${tool.exitCode}`}
          </span>
        )}
        {label && <span className="tool-duration">{label}</span>}
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
  }: {
    activities: ToolActivity[];
    visible: boolean;
  }) {
    const [now, setNow] = useState(Date.now);
    const group = useRef<HTMLDetailsElement>(null);
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
    if (!activities.length) return null;
    const failed = activities.filter((tool) => tool.status === "failed").length;
    const current = active.at(-1);
    return (
      <details className="tool-activity-group" ref={group}>
        <summary
          aria-label={`Tool activity, ${activities.length} ${activities.length === 1 ? "step" : "steps"}${running ? ", running" : ""}${failed ? `, ${failed} failed` : ""}`}
        >
          <span className="activity-chevron" aria-hidden="true">
            ›
          </span>
          {current && <ToolIcon kind={current.kind} />}
          <span className="activity-summary-title">
            {current?.title ?? `${activities.length} ${activities.length === 1 ? "step" : "steps"}`}
          </span>
          {running && (
            <span className="activity-count">
              {active.length > 1 ? `${active.length} running` : "Running"}
            </span>
          )}
          {failed > 0 && <span className="tool-status-failed">{failed} failed</span>}
        </summary>
        <div className="tool-activity-list">
          {activities.map((tool) => (
            <ToolRow key={tool.id} tool={tool} now={tool.endedAt ? 0 : now} />
          ))}
        </div>
      </details>
    );
  },
  (previous, next) =>
    previous.visible === next.visible &&
    previous.activities.length === next.activities.length &&
    previous.activities.every((tool, index) => tool === next.activities[index]),
);
