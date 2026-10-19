import { expect, test } from "bun:test";
import { createClaudeParser, type HarnessUpdate } from "./harnesses";
import { commandKind, createToolEventParser, plainToolText } from "./tool-events";
import { MAX_TOOL_INPUT, MAX_TOOL_OUTPUT, type ToolActivityUpdate } from "../shared/tool-activity";

function fixture(harness: "codex" | "claude") {
  const snapshots: ToolActivityUpdate[] = [];
  const parse = createToolEventParser(harness, (value) => snapshots.push(structuredClone(value)));
  const latest = (id: string) =>
    snapshots
      .slice()
      .reverse()
      .find((tool) => tool.id === id)!;
  return { parse, snapshots, latest };
}

test("Codex command snapshots replace output, preserve exit failures and ignore late starts", () => {
  const { parse, latest, snapshots } = fixture("codex");
  const item = { id: "test", type: "command_execution", command: "bun test" };
  parse({ type: "item.started", item });
  parse({ type: "item.updated", item: { ...item, aggregated_output: "Running\n" } });
  parse({
    type: "item.completed",
    item: { ...item, aggregated_output: "Running\n1 failed", exit_code: 1 },
  });
  parse({ type: "item.started", item });
  expect(snapshots).toHaveLength(3);
  expect(latest("test")).toMatchObject({
    kind: "test",
    status: "failed",
    exitCode: 1,
    output: "Running\n1 failed",
  });
});

test("Codex records reported file changes, searches and MCP text without reasoning or image data", () => {
  const { parse, latest, snapshots } = fixture("codex");
  parse({
    type: "item.completed",
    item: {
      id: "edit",
      type: "file_change",
      changes: [
        { path: "src/app.tsx", kind: "update" },
        { path: "old.ts", kind: "delete" },
        { path: "new.ts", kind: "add" },
      ],
    },
  });
  expect(latest("edit").files).toEqual([
    { path: "src/app.tsx", kind: "modified" },
    { path: "old.ts", kind: "deleted" },
    { path: "new.ts", kind: "added" },
  ]);
  expect(latest("edit").input).toBeUndefined();
  parse({
    type: "item.completed",
    item: { id: "search", type: "web_search", query: "React documentation" },
  });
  expect(latest("search")).toMatchObject({
    kind: "search",
    title: "React documentation",
    status: "completed",
  });
  parse({
    type: "item.completed",
    item: {
      id: "mcp",
      type: "mcp_tool_call",
      server: "tidy",
      tool: "read_design",
      arguments: { id: "design", api_key: "private-key" },
      result: {
        content: [
          { type: "text", text: "81 layers" },
          { type: "image", data: "private-image" },
        ],
      },
    },
  });
  expect(latest("mcp").input).toContain("[redacted]");
  expect(latest("mcp").output).toBe("81 layers");
  parse({
    type: "item.completed",
    item: { id: "reason", type: "reasoning", text: "private reasoning" },
  });
  parse({ type: "system", api_key: "private-auth" });
  expect(JSON.stringify(snapshots)).not.toMatch(
    /private-key|private-image|private reasoning|private-auth/,
  );
});

test("tool output is terminal-safe and bounded, retaining the latest output and the beginning of input", () => {
  const { parse, latest } = fixture("codex");
  expect(plainToolText("\x1b[31mFAIL\x1b[0m\r\n\x1b]0;window\x07done\x00")).toBe("FAIL\ndone");
  parse({
    type: "item.completed",
    item: {
      id: "large",
      type: "command_execution",
      command: "head " + "i".repeat(MAX_TOOL_INPUT),
      aggregated_output: "o".repeat(MAX_TOOL_OUTPUT) + "END",
      exit_code: 0,
    },
  });
  expect(latest("large").input).toHaveLength(MAX_TOOL_INPUT);
  expect(latest("large").output).toHaveLength(MAX_TOOL_OUTPUT);
  expect(latest("large").output).toEndWith("END");
  expect(latest("large")).toMatchObject({ inputTruncated: true, outputTruncated: true });
});

test("Claude fragments become one tool with matching results, including parallel and nested calls", () => {
  const { parse, latest, snapshots } = fixture("claude");
  const stream = (event: unknown, parent_tool_use_id?: string) =>
    parse({ type: "stream_event", event, parent_tool_use_id });
  stream({ type: "message_start", message: { id: "m1" } });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "test", name: "Bash", input: {} },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"command":"bun ' },
  });
  // Interleaved subagent message with the same block index must not steal its parent's input.
  stream({ type: "message_start", message: { id: "nested-message" } }, "agent");
  stream(
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "read",
        name: "Read",
        input: { file_path: "src/app.tsx" },
      },
    },
    "agent",
  );
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: 'test"}' },
  });
  stream({ type: "content_block_stop", index: 0 });
  expect(latest("test")).toMatchObject({ kind: "test", input: "bun test" });
  expect(latest("read").parentToolId).toBe("agent");
  parse({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "test", is_error: true, content: "fallback" }],
    },
    tool_use_result: { stdout: "Running", stderr: "Expected 2, got 1", exitCode: 1 },
  });
  parse({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "read",
          content: [{ type: "text", text: "file source" }],
        },
      ],
    },
  });
  parse({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "test", name: "Bash", input: { command: "bun test" } }],
    },
  });
  parse({ type: "tool_progress", tool_use_id: "test", tool_name: "Bash" });
  expect(latest("test")).toMatchObject({
    status: "failed",
    exitCode: 1,
    output: "Running\nExpected 2, got 1",
  });
  expect(latest("read")).toMatchObject({ status: "completed", output: "file source" });
  expect(new Set(snapshots.map((tool) => tool.id)).size).toBe(2);
});

test("Claude edit details and server search results remain inspectable", () => {
  const { parse, latest } = fixture("claude");
  parse({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: "src/app.tsx", old_string: "before", new_string: "after" },
        },
        { type: "server_tool_use", id: "search", name: "web_search", input: { query: "docs" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "search",
          content: [
            {
              type: "web_search_result",
              title: "Documentation",
              url: "https://example.invalid/docs",
            },
          ],
        },
      ],
    },
  });
  expect(latest("edit").input).toBe("src/app.tsx\n--- Before\nbefore\n+++ After\nafter");
  expect(latest("edit").files).toEqual([{ path: "src/app.tsx", kind: "modified" }]);
  expect(latest("search")).toMatchObject({ kind: "search", status: "completed" });
  expect(latest("search").output).toContain("Documentation");
});

test("Claude background task completion retains earlier output and excludes ambient notifications", () => {
  const { parse, latest, snapshots } = fixture("claude");
  parse({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "bg", name: "Bash", input: { command: "bun test" } }],
    },
  });
  parse({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "bg", content: "Started background command" }],
    },
  });
  parse({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "bg" });
  expect(latest("bg").status).toBe("running");
  parse({
    type: "system",
    subtype: "task_notification",
    task_id: "task",
    status: "completed",
    summary: "3 tests passed",
  });
  expect(latest("bg")).toMatchObject({
    status: "completed",
    output: "Started background command\n3 tests passed",
  });
  const count = snapshots.length;
  parse({
    type: "system",
    subtype: "task_started",
    task_id: "ambient",
    tool_use_id: "private",
    ambient: true,
  });
  expect(snapshots).toHaveLength(count);
});

test("a failed tool is activity, not a turn error, and text precedes its tools", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createClaudeParser((update) => updates.push(update));
  parse({
    type: "assistant",
    message: {
      id: "message",
      content: [
        { type: "text", text: "I’ll run tests." },
        { type: "thinking", thinking: "private" },
        { type: "tool_use", id: "test", name: "Bash", input: { command: "bun test" } },
      ],
    },
  });
  parse({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "test", is_error: true, content: "1 failed" }],
    },
  });
  expect(updates.map((update) => update.type)).toEqual(["message", "tool", "tool"]);
  expect(JSON.stringify(updates)).not.toContain("private");
});

test("shell commands classify common test runners and local searches without inventing results", () => {
  for (const command of [
    "bun test",
    "npm run test:unit",
    "pnpm exec vitest run",
    "python3 -m pytest",
    "cargo test",
    "go test ./...",
  ])
    expect(commandKind(command)).toBe("test");
  expect(commandKind('rg -n "Button" src')).toBe("search");
  expect(commandKind("git status --short")).toBe("command");
});
