#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

if (process.argv.includes("login") && process.argv.includes("status")) process.exit(0);
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}

let structuredInput;
const metadataArgs = process.argv.slice(2);
if (metadataArgs[0] === "app-server" || metadataArgs.includes("--input-format")) {
  const codex = metadataArgs[0] === "app-server";
  const methods = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const value = JSON.parse(line);
    if (value.type === "user") {
      structuredInput = value;
      break;
    }
    const method = codex ? value.method : value.request?.subtype;
    methods.push(method);
    writeFileSync("capability-invocation.json", JSON.stringify({ methods, cwd: process.cwd() }));
    const reply = (result) =>
      console.log(
        JSON.stringify(
          codex
            ? { id: value.id, result }
            : {
                type: "control_response",
                response: { subtype: "success", request_id: value.request_id, response: result },
              },
        ),
      );
    if (method === "initialize")
      reply(
        codex
          ? {}
          : {
              models: [
                {
                  value: "default",
                  displayName: "Default Claude",
                  supportsEffort: true,
                  supportedEffortLevels: ["low", "high"],
                },
                {
                  value: "fixture-claude",
                  displayName: "Fixture Claude",
                  supportsEffort: true,
                  supportedEffortLevels: ["low", "high"],
                },
              ],
              account: { email: "private@example.invalid", tokenSource: "oauth" },
            },
      );
    else if (method === "model/list")
      reply({
        data: [
          {
            model: "fixture-codex",
            displayName: "Fixture Codex",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
          },
        ],
        nextCursor: null,
      });
    else if (method === "config/read")
      reply({
        config: { model: "fixture-codex", model_reasoning_effort: "high", secret: "do-not-expose" },
      });
    else if (method === "account/rateLimits/read")
      reply({
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 },
          secondary: null,
        },
      });
    else if (method === "account/read")
      reply({ account: { type: "chatgpt", email: "private@example.invalid" } });
    else if (method !== "initialized") throw Error("Unexpected capability request: " + method);
  }
  if (!structuredInput) process.exit(0);
}

let prompt = structuredInput ? JSON.stringify(structuredInput) + "\n" : "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
writeFileSync(
  "harness-invocation.json",
  JSON.stringify({
    cwd: process.cwd(),
    args,
    prompt,
    inheritedElectron: process.env.ELECTRON_RUN_AS_NODE,
    database: process.env.DATABASE_URL,
  }),
);
const session = "b56ba7bb-00aa-4a56-a64c-593c3c377dcc";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const codex = args[0] === "exec";
if (prompt.includes("invalid-event")) {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (prompt.includes("tool-activity-fixture")) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  send(
    codex
      ? { type: "thread.started", thread_id: session }
      : { type: "system", session_id: session, model: "fixture-claude" },
  );
  const message = (id, text) =>
    send(
      codex
        ? { type: "item.completed", item: { id, type: "agent_message", text } }
        : { type: "assistant", message: { id, content: [{ type: "text", text }] } },
    );
  message("comment", "I’ll inspect the project and run its tests.");
  if (codex) {
    const command = {
      id: "test",
      type: "command_execution",
      command: "bun test src/button.test.ts",
    };
    send({ type: "item.started", item: command });
    await pause(100);
    send({
      type: "item.updated",
      item: { ...command, aggregated_output: "Running button tests…\n" },
    });
    await pause(600);
    send({
      type: "item.updated",
      item: {
        ...command,
        aggregated_output: "Running button tests…\nChecking keyboard interaction\n",
      },
    });
    if (prompt.includes("hold")) {
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    await pause(600);
    send({
      type: "item.completed",
      item: {
        ...command,
        aggregated_output:
          "Running button tests…\nFAIL expected <button> to be enabled\n1 failed, 2 passed",
        exit_code: 1,
      },
    });
    send({
      type: "item.completed",
      item: {
        id: "search",
        type: "command_execution",
        command: 'rg -n "disabled" src/button.tsx',
        aggregated_output: "12: disabled={pending}",
        exit_code: 0,
      },
    });
    send({
      type: "item.completed",
      item: {
        id: "edit",
        type: "file_change",
        changes: [{ path: "src/button.tsx", kind: "update" }],
      },
    });
    send({
      type: "item.completed",
      item: {
        id: "verify",
        type: "command_execution",
        command: "bun test src/button.test.ts",
        aggregated_output: "3 passed\n0 failed",
        exit_code: 0,
      },
    });
  } else {
    const start = (id, name, input) =>
      send({
        type: "assistant",
        message: { id: "call-" + id, content: [{ type: "tool_use", id, name, input }] },
      });
    const result = (id, content, is_error = false) =>
      send({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
      });
    start("test", "Bash", { command: "bun test src/button.test.ts" });
    await pause(100);
    send({ type: "tool_progress", tool_use_id: "test", tool_name: "Bash" });
    if (prompt.includes("hold")) {
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    await pause(100);
    result("test", "FAIL expected <button> to be enabled\n1 failed, 2 passed", true);
    start("search", "Grep", { pattern: "disabled", path: "src/button.tsx" });
    result("search", "12: disabled={pending}");
    start("edit", "Edit", {
      file_path: "src/button.tsx",
      old_string: "disabled={pending}",
      new_string: "disabled={pending && !ready}",
    });
    result("edit", "The file was updated successfully.");
    start("verify", "Bash", { command: "bun test src/button.test.ts" });
    result("verify", "3 passed\n0 failed");
  }
  message("final", "Fixed the button state. All three tests pass.");
  send(
    codex
      ? { type: "turn.completed", usage: { input_tokens: 120, output_tokens: 40 } }
      : { type: "result", usage: { input_tokens: 125, output_tokens: 45 } },
  );
  process.exit(0);
}
if (prompt.includes("wait-for-stop")) {
  spawn(
    process.execPath,
    [
      "-e",
      'setTimeout(() => require("node:fs").writeFileSync("orphan.txt", "still running"), 800)',
    ],
    { stdio: "ignore" },
  );
  send(
    codex
      ? { type: "thread.started", thread_id: session }
      : { type: "system", session_id: session },
  );
  setInterval(() => {}, 1000);
} else if (codex) {
  send({ type: "thread.started", thread_id: session });
  send({
    type: "item.completed",
    item: { id: "reason", type: "reasoning", text: "private reasoning" },
  });
  send({
    type: "item.started",
    item: { id: "command", type: "command_execution", command: "read project" },
  });
  send({
    type: "item.completed",
    item: {
      id: "response",
      type: "agent_message",
      text: "Ready to implement this project's design.",
    },
  });
  send({
    type: "turn.completed",
    usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 },
  });
} else {
  send({ type: "system", session_id: session, model: "fixture-claude" });
  send({ type: "stream_event", event: { type: "message_start", message: { id: "response" } } });
  send({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
  });
  send({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "project" } },
  });
  send({
    type: "assistant",
    message: {
      id: "response",
      content: [
        { type: "text", text: "Hello project" },
        { type: "thinking", thinking: "private reasoning" },
      ],
    },
  });
  send({
    type: "result",
    session_id: session,
    result: "Hello project",
    is_error: false,
    total_cost_usd: 0.05,
    modelUsage: {
      "fixture-claude": {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
      },
    },
  });
}
