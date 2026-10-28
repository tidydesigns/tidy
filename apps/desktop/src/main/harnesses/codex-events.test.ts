import { expect, test } from "bun:test";
import { createCodexEvents } from "./codex-events";
import type { HarnessUpdate } from "./harnesses";

test("App Server deltas and final snapshots preserve streamed text, command output and exit failures", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createCodexEvents((update) => updates.push(update));
  parse("item/agentMessage/delta", { itemId: "message", delta: "Checking " });
  parse("item/agentMessage/delta", { itemId: "message", delta: "tests" });
  parse("item/completed", {
    item: { id: "message", type: "agentMessage", text: "Checking tests" },
  });
  parse("item/started", {
    item: {
      id: "test",
      type: "commandExecution",
      command: "bun test",
      status: "inProgress",
      aggregatedOutput: null,
    },
  });
  parse("item/commandExecution/outputDelta", { itemId: "test", delta: "\x1b[31mFAIL\x1b[0m\n" });
  parse("item/commandExecution/outputDelta", { itemId: "test", delta: "1 failed" });
  parse("item/completed", {
    item: {
      id: "test",
      type: "commandExecution",
      command: "bun test",
      status: "failed",
      aggregatedOutput: "FAIL\n1 failed",
      exitCode: 1,
    },
  });
  const tools = updates.filter((update) => update.type === "tool");
  expect(tools.at(-2)!.tool.output).toBe("FAIL\n1 failed");
  expect(tools.at(-1)!.tool).toMatchObject({
    kind: "test",
    status: "failed",
    output: "FAIL\n1 failed",
    exitCode: 1,
  });
  expect(updates.filter((update) => update.type === "message")).toEqual([
    { type: "message", id: "message", text: "Checking ", append: true },
    { type: "message", id: "message", text: "tests", append: true },
    { type: "message", id: "message", text: "Checking tests" },
  ]);
  expect(updates.some((update) => update.type === "error")).toBe(false);
});
test("App Server file changes retain the native patch and usage remains cumulative across resumes", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createCodexEvents((update) => updates.push(update));
  parse("item/completed", {
    item: {
      id: "edit",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/app.tsx", kind: { type: "update", move_path: null }, diff: "-before\n+after" },
      ],
    },
  });
  const tool = updates.find((update) => update.type === "tool");
  expect(tool?.type === "tool" && tool.tool.input).toBe("src/app.tsx\n-before\n+after");
  expect(tool?.type === "tool" && tool.tool.files).toEqual([
    { path: "src/app.tsx", kind: "modified" },
  ]);
  parse("thread/tokenUsage/updated", {
    tokenUsage: {
      total: { inputTokens: 240, cachedInputTokens: 40, outputTokens: 80 },
      last: { inputTokens: 120 },
    },
  });
  expect(updates.at(-1)).toEqual({
    type: "usage",
    usage: { inputTokens: 240, cachedInputTokens: 40, outputTokens: 80 },
    cumulative: true,
  });
  const count = updates.length;
  parse("item/started", {
    item: { id: "reason", type: "reasoning", content: ["private reasoning"] },
  });
  parse("account/updated", { api_key: "private-auth" });
  expect(updates.slice(count)).toEqual([{ type: "activity", activity: "Thinking" }]);
  expect(JSON.stringify(updates)).not.toMatch(/private reasoning|private-auth/);
});
test("large command deltas retain bounded recent output with a visible truncation flag", () => {
  const updates: HarnessUpdate[] = [];
  const parse = createCodexEvents((update) => updates.push(update));
  parse("item/started", {
    item: { id: "large", type: "commandExecution", command: "bun test", status: "inProgress" },
  });
  for (let index = 0; index < 10; index++)
    parse("item/commandExecution/outputDelta", { itemId: "large", delta: "output\n".repeat(1000) });
  const last = updates.at(-1);
  expect(last?.type).toBe("tool");
  if (last?.type === "tool") {
    expect(last.tool.output).toHaveLength(32_000);
    expect(last.tool.outputTruncated).toBe(true);
    expect(last.tool.kind).toBe("test");
  }
});
