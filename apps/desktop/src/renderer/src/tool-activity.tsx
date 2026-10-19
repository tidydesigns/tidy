import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toolStatusLabel, type ToolActivity } from "../../shared/tool-activity";
const kinds = {
  command: "Command",
  test: "Test",
  search: "Search",
  edit: "File edit",
  read: "Read",
  tool: "Tool",
};
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
function Output({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(streaming);
  useLayoutEffect(() => {
    if (ref.current && following.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="tool-output"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (!element.clientHeight) return;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {text}
    </pre>
  );
}
function ToolRow({ tool, now }: { tool: ToolActivity; now: number }) {
  const label = elapsed(tool, now);
  return (
    <details className={`tool-call ${tool.parentToolId ? "tool-call-nested" : ""}`}>
      <summary>
        <ToolIcon kind={tool.kind} />
        <span className="tool-call-title" title={tool.title}>
          {tool.title}
        </span>
        <span className={`tool-status tool-status-${tool.status}`}>
          {toolStatusLabel[tool.status]}
        </span>
        {label && <span className="tool-duration">{label}</span>}
        <span className="activity-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      <div className="tool-call-details">
        <div className="tool-call-meta">
          <span>{kinds[tool.kind]}</span>
          <span>{tool.toolName}</span>
          {tool.parentToolId && <span>Agent tool</span>}
          {tool.exitCode !== undefined && <span>Exit {tool.exitCode}</span>}
        </div>
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
        {tool.input && (
          <div className="tool-detail-section">
            <span>
              {tool.kind === "command" || tool.kind === "test"
                ? "Command"
                : tool.kind === "edit"
                  ? "Edit"
                  : "Input"}
            </span>
            <pre className="tool-input" tabIndex={0}>
              {tool.input}
            </pre>
            {tool.inputTruncated && <small>Input shortened</small>}
          </div>
        )}
        {tool.output ? (
          <div className="tool-detail-section">
            <span>Output</span>
            <Output text={tool.output} streaming={tool.status === "running"} />
            {tool.outputTruncated && <small>Earlier output omitted</small>}
          </div>
        ) : (
          !tool.files?.length && (
            <p className="tool-empty-output">
              {tool.status === "running" ? "Waiting for output…" : "No text output"}
            </p>
          )
        )}
      </div>
    </details>
  );
}
export function ToolActivityGroup({ activities }: { activities: ToolActivity[] }) {
  const [now, setNow] = useState(Date.now);
  const active = activities.filter((tool) => tool.status === "running");
  const running = active.length > 0;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!activities.length) return null;
  const failed = activities.filter((tool) => tool.status === "failed").length;
  const current = active.at(-1);
  return (
    <details className="tool-activity-group">
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
          <ToolRow key={tool.id} tool={tool} now={now} />
        ))}
      </div>
    </details>
  );
}
