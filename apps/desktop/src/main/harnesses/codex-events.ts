import type { HarnessUpdate } from "./harnesses";
import { createToolEventParser } from "./tool-events";
import { MAX_TOOL_OUTPUT } from "../../shared/contracts/tool-activity";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Convert App Server's public v2 items into the same bounded timeline as exec JSON. */
export function createCodexEvents(emit: (update: HarnessUpdate) => void) {
  const parse = createToolEventParser("codex", (tool) => emit({ type: "tool", tool }));
  const items = new Map<string, Record<string, unknown>>();
  return (method: string, params: Record<string, unknown>) => {
    if (method === "item/agentMessage/delta")
      emit({ type: "message", id: text(params.itemId), text: text(params.delta), append: true });
    if (method === "thread/tokenUsage/updated") {
      // App Server reports native session totals, including resumed turns.
      const usage = object(object(params.tokenUsage).total);
      const count = (key: string) => {
        const value = usage[key];
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
      };
      emit({
        type: "usage",
        usage: {
          inputTokens: count("inputTokens"),
          outputTokens: count("outputTokens"),
          cachedInputTokens: count("cachedInputTokens"),
        },
        cumulative: true,
      });
    }
    if (method === "item/commandExecution/outputDelta") {
      const id = text(params.itemId),
        previous = items.get(id);
      if (!previous) return;
      const output = text(previous.aggregated_output) + text(params.delta);
      const next = { ...previous, aggregated_output: output.slice(-MAX_TOOL_OUTPUT - 1) };
      items.set(id, next);
      parse({ type: "item.updated", item: next });
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = object(params.item),
      id = text(item.id),
      type = text(item.type);
    if (!id) return;
    if (type === "reasoning") {
      emit({ type: "activity", activity: method === "item/started" ? "Thinking" : "Working" });
      return;
    }
    const event = method === "item/started" ? "item.started" : "item.completed";
    if (type === "agentMessage") {
      if (method === "item/completed") emit({ type: "message", id, text: text(item.text) });
      return;
    }
    if (type === "commandExecution") {
      const normalized = {
        ...item,
        id,
        type: "command_execution",
        aggregated_output: item.aggregatedOutput ?? items.get(id)?.aggregated_output,
        exit_code: item.exitCode,
        status: item.status === "declined" ? "failed" : item.status,
      };
      if (method === "item/started" && items.size < 1000) items.set(id, normalized);
      parse({ type: event, item: normalized });
      if (method === "item/completed") items.delete(id);
    } else if (type === "fileChange") {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(object);
      parse({
        type: event,
        item: {
          ...item,
          type: "file_change",
          status: item.status === "declined" ? "failed" : item.status,
          changes: changes.map((change) => ({ path: change.path, kind: object(change.kind).type })),
          patch: changes
            .map((change) => [text(change.path), text(change.diff)].join("\n"))
            .join("\n\n"),
        },
      });
    } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
      const result = object(item.result);
      parse({
        type: event,
        item: {
          ...item,
          type: type === "mcpToolCall" ? "mcp_tool_call" : "dynamic_tool_call",
          result: { ...result, structured_content: result.structuredContent },
          content_items: item.contentItems,
          status: item.success === false ? "failed" : item.status,
        },
      });
    } else if (type === "webSearch") parse({ type: event, item: { ...item, type: "web_search" } });
    // Reasoning, auth and raw control payloads are intentionally not transcript items.
  };
}
