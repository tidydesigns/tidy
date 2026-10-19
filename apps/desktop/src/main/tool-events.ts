import { MAX_TOOL_INPUT, MAX_TOOL_OUTPUT, type ToolActivityUpdate } from "../shared/tool-activity";
import type { HarnessId } from "../shared/contracts";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
/** Only visible text is retained. Terminal escape sequences never reach the UI or saved transcript. */
export function plainToolText(value: string) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(record)
    .filter((block) => block.type === "text" || block.type === "output_text")
    .map((block) => text(block.text))
    .join("\n");
}
function safeInput(value: unknown): string {
  if (typeof value === "string") return value;
  return (
    JSON.stringify(
      value,
      (key, item) =>
        /(?:^|_)(?:thinking|reasoning|signature|encrypted_content|password|secret|api_key|authorization|access_token|refresh_token)(?:$|_)/i.test(
          key,
        )
          ? "[redacted]"
          : item,
      2,
    ) ?? ""
  );
}
export function commandKind(command: string): ToolActivityUpdate["kind"] {
  if (
    /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test(?:[\w:-]*)?|vitest|jest|playwright)\b|\b(?:pytest|vitest|jest|rspec|ctest)\b|\b(?:cargo|go|dotnet|gradle|mvn|xcodebuild|playwright)\s+test\b|\bpython\S*\s+-m\s+(?:pytest|unittest)\b/i.test(
      command,
    )
  )
    return "test";
  if (/(?:^|[\s;&|])(?:rg|grep|find|fd)\s/.test(command)) return "search";
  return "command";
}
/** Fold repeated native events into one tool call. Never inspect thinking/auth/control payloads. */
export function createToolEventParser(
  harness: HarnessId,
  emit: (tool: ToolActivityUpdate) => void,
) {
  const tools = new Map<string, ToolActivityUpdate>();
  const blocks = new Map<string, { id: string; input: string }>();
  const tasks = new Map<string, string>();
  const messageIds = new Map<string, string>();
  function publish(update: ToolActivityUpdate) {
    if (!update.id || update.id.length > 200 || (!tools.has(update.id) && tools.size >= 1000))
      return;
    const previous = tools.get(update.id);
    const next = { ...previous, ...update };
    const input = plainToolText(next.input ?? ""),
      output = plainToolText(next.output ?? "");
    next.title = plainToolText(next.title).slice(0, 240);
    next.toolName = plainToolText(next.toolName).slice(0, 120);
    if (next.input !== undefined) {
      next.input = input.slice(0, MAX_TOOL_INPUT);
      next.inputTruncated = Boolean(next.inputTruncated || input.length > MAX_TOOL_INPUT);
    }
    if (next.output !== undefined) {
      next.output = output.slice(-MAX_TOOL_OUTPUT);
      next.outputTruncated = Boolean(next.outputTruncated || output.length > MAX_TOOL_OUTPUT);
    }
    tools.set(next.id, next);
    emit(next);
  }
  function claudeStart(block: Record<string, unknown>, parentToolId?: string) {
    const id = text(block.id),
      name = text(block.name),
      input = record(block.input);
    if (!id || !name) return;
    const previous = tools.get(id);
    let kind: ToolActivityUpdate["kind"] = "tool",
      title = name,
      details = safeInput(block.input ?? {});
    let files: ToolActivityUpdate["files"];
    if (name === "Bash" || name === "BashOutput" || name === "Shell") {
      const command = text(input.command);
      kind = commandKind(command);
      title = command || text(input.description) || name;
      details = command || details;
    } else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
      kind = "edit";
      const path = text(input.file_path) || text(input.notebook_path);
      title = path ? `${name === "Write" ? "Write" : "Edit"} ${path}` : name;
      if (path)
        files = [{ path: path.slice(0, 1000), kind: name === "Write" ? "written" : "modified" }];
      if (name === "Edit")
        details = `${path}\n--- Before\n${text(input.old_string)}\n+++ After\n${text(input.new_string)}`;
      else if (name === "Write") details = `${path}\n${text(input.content)}`;
    } else if (
      [
        "Grep",
        "Glob",
        "WebSearch",
        "WebFetch",
        "ToolSearch",
        "web_search",
        "web_fetch",
        "tool_search",
      ].includes(name)
    ) {
      kind = "search";
      title = text(input.pattern) || text(input.query) || text(input.url) || name;
    } else if (name === "Read") {
      kind = "read";
      title = text(input.file_path) || name;
    }
    publish({
      id,
      toolName: name,
      kind,
      title,
      status: previous?.status ?? "running",
      input: details,
      ...(files ? { files } : {}),
      ...(parentToolId ? { parentToolId: parentToolId.slice(0, 200) } : {}),
    });
  }
  return (raw: unknown) => {
    const value = record(raw);
    if (harness === "codex") {
      if (!["item.started", "item.updated", "item.completed"].includes(text(value.type))) return;
      const item = record(value.item),
        id = text(item.id),
        type = text(item.type);
      if (!id) return;
      let kind: ToolActivityUpdate["kind"],
        toolName: string,
        title: string,
        input: string | undefined,
        output: string | undefined;
      let files: ToolActivityUpdate["files"];
      const previous = tools.get(id);
      // Duplicate snapshots must not reopen an already finished native item.
      if (previous && previous.status !== "running" && value.type !== "item.completed") return;
      const status: ToolActivityUpdate["status"] =
        item.status === "failed" ||
        (integer(item.exit_code) !== undefined && item.exit_code !== 0) ||
        item.error
          ? "failed"
          : value.type === "item.completed"
            ? "completed"
            : "running";
      if (type === "command_execution") {
        title = text(item.command) || tools.get(id)?.title || "Command";
        toolName = "Shell";
        input = title;
        kind = commandKind(title);
        if (typeof item.aggregated_output === "string") output = item.aggregated_output;
      } else if (type === "file_change") {
        kind = "edit";
        toolName = "File edit";
        files = (Array.isArray(item.changes) ? item.changes : [])
          .slice(0, 50)
          .map(record)
          .filter((change) => typeof change.path === "string")
          .map((change) => ({
            path: text(change.path).slice(0, 1000),
            kind:
              change.kind === "add" ? "added" : change.kind === "delete" ? "deleted" : "modified",
          }));
        title = files.length === 1 ? files[0].path : `${files.length} files`;
        const patch = text(item.patch) || text(item.diff);
        if (patch) input = patch;
      } else if (type === "web_search") {
        kind = "search";
        toolName = "Web search";
        const action = record(item.action);
        title = text(item.query) || text(action.query) || text(action.url) || "Web search";
        const queries = Array.isArray(item.queries)
          ? item.queries.filter((query) => typeof query === "string")
          : [];
        input = queries.length ? queries.join("\n") : title;
        if (item.result) output = contentText(item.result);
      } else if (type === "mcp_tool_call" || type === "dynamic_tool_call") {
        kind = "tool";
        toolName = [text(item.server), text(item.tool)].filter(Boolean).join(" / ") || "Tool";
        title = toolName;
        input = safeInput(item.arguments);
        const result = record(item.result);
        output =
          contentText(result.content) ||
          (result.structured_content !== undefined ? safeInput(result.structured_content) : "") ||
          text(record(item.error).message) ||
          contentText(item.content_items);
      } else return;
      publish({
        id,
        kind,
        toolName,
        title,
        status,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(files ? { files } : {}),
        ...(integer(item.exit_code) !== undefined ? { exitCode: integer(item.exit_code) } : {}),
      });
      return;
    }
    const parent = text(value.parent_tool_use_id) || undefined;
    if (parent && parent.length > 200) return;
    if (value.type === "stream_event") {
      const event = record(value.event),
        block = record(event.content_block);
      const scope = parent ?? "root";
      if (event.type === "message_start" && (messageIds.has(scope) || messageIds.size < 1000))
        messageIds.set(scope, text(record(event.message).id).slice(0, 200));
      const key = `${scope}:${messageIds.get(scope) ?? ""}:${integer(event.index) ?? 0}`;
      if (
        event.type === "content_block_start" &&
        ["tool_use", "server_tool_use"].includes(text(block.type))
      ) {
        claudeStart(block, parent);
        const id = text(block.id);
        if (tools.has(id) && (blocks.has(key) || blocks.size < 1000))
          blocks.set(key, { id, input: "" });
      }
      const delta = record(event.delta),
        current = blocks.get(key);
      if (current && delta.type === "input_json_delta") {
        current.input = (current.input + text(delta.partial_json)).slice(0, MAX_TOOL_INPUT * 8);
        // Tool arguments are only parsed when complete; incomplete JSON is never shown as a result.
      }
      if (current && event.type === "content_block_stop") {
        try {
          claudeStart(
            {
              id: current.id,
              name: tools.get(current.id)?.toolName,
              input: JSON.parse(current.input),
            },
            parent,
          );
        } catch {}
        blocks.delete(key);
      }
      if (event.type === "content_block_start") serverResult(block);
      return;
    }
    function serverResult(block: Record<string, unknown>) {
      if (!text(block.type).endsWith("_tool_result")) return;
      const id = text(block.tool_use_id),
        previous = tools.get(id);
      if (!previous) return;
      const content = block.content;
      const failed =
        record(content).type === "web_search_tool_result_error" ||
        record(content).type === "web_fetch_tool_result_error";
      publish({
        ...previous,
        status: failed ? "failed" : "completed",
        output: contentText(content) || safeInput(content),
      });
    }
    if (value.type === "assistant") {
      for (const block of (Array.isArray(record(value.message).content)
        ? (record(value.message).content as unknown[])
        : []
      ).map(record))
        if (["tool_use", "server_tool_use"].includes(text(block.type))) claudeStart(block, parent);
        else serverResult(block);
    }
    if (value.type === "user") {
      const content = record(value.message).content;
      const results = (Array.isArray(content) ? content : [])
        .map(record)
        .filter((block) => block.type === "tool_result");
      for (const result of results) {
        const id = text(result.tool_use_id),
          previous = tools.get(id);
        const structured = results.length === 1 ? record(value.tool_use_result) : {};
        const code = integer(structured.exitCode) ?? integer(structured.exit_code);
        const output =
          [text(structured.stdout), text(structured.stderr)].filter(Boolean).join("\n") ||
          contentText(result.content);
        publish({
          id,
          kind: previous?.kind ?? "tool",
          title: previous?.title ?? "Tool result",
          toolName: previous?.toolName ?? "Tool",
          status: structured.interrupted
            ? "cancelled"
            : result.is_error || (code !== undefined && code !== 0)
              ? "failed"
              : "completed",
          output,
          ...(code !== undefined ? { exitCode: code } : {}),
        });
      }
    }
    if (value.type === "tool_progress") {
      const id = text(value.tool_use_id),
        previous = tools.get(id);
      if (previous && previous.status !== "running") return;
      publish({
        id,
        kind: previous?.kind ?? "tool",
        title: previous?.title ?? text(value.tool_name),
        toolName: previous?.toolName ?? text(value.tool_name),
        status: "running",
        ...(parent ? { parentToolId: parent } : {}),
      });
    }
    if (
      value.type === "system" &&
      ["task_started", "task_progress", "task_notification"].includes(text(value.subtype))
    ) {
      if (value.ambient || value.skip_transcript) return;
      const taskId = text(value.task_id),
        id = text(value.tool_use_id) || tasks.get(taskId);
      if (!id || id.length > 200 || taskId.length > 200) return;
      if (!tasks.has(taskId) && tasks.size >= 1000) return;
      tasks.set(taskId, id);
      const previous = tools.get(id);
      publish({
        id,
        kind: previous?.kind ?? "tool",
        title: previous?.title ?? (text(value.description) || "Background task"),
        toolName: previous?.toolName ?? "Task",
        status:
          value.subtype === "task_notification"
            ? value.status === "completed"
              ? "completed"
              : value.status === "stopped"
                ? "cancelled"
                : "failed"
            : "running",
        ...(value.subtype === "task_notification" && text(value.summary)
          ? { output: [previous?.output, text(value.summary)].filter(Boolean).join("\n") }
          : {}),
      });
    }
  };
}
