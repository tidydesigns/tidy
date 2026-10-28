#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

if (process.argv.includes("login") && process.argv.includes("status")) process.exit(0);
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}

let structuredInput, threadParams, turnParams;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const session = "b56ba7bb-00aa-4a56-a64c-593c3c377dcc";
const turn = "fixture-turn";
const metadataArgs = process.argv.slice(2);
if (metadataArgs[0] === "app-server" || metadataArgs.includes("--input-format")) {
  const codex = metadataArgs[0] === "app-server";
  const methods = [];
  while (true) {
    const line = await lines.next();
    if (line.done) break;
    const value = JSON.parse(line.value);
    if (value.type === "user") {
      structuredInput = value;
      break;
    }
    const method = codex ? value.method : value.request?.subtype;
    if (method === "model/list" && existsSync("metadata-delay-ms"))
      await new Promise((resolve) =>
        setTimeout(resolve, Number(readFileSync("metadata-delay-ms", "utf8"))),
      );
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
    if (method === "thread/start" || method === "thread/resume") {
      threadParams = value.params;
      reply({ thread: { id: session }, model: "fixture-codex" });
    } else if (method === "turn/start") {
      turnParams = value.params;
      reply({ turn: { id: turn } });
      break;
    } else if (method === "initialize")
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
    else if (method === "skills/list") reply({ data: [{ cwd: process.cwd(), skills: [] }] });
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
  if (!structuredInput && !turnParams) process.exit(0);
}

let prompt = structuredInput
  ? JSON.stringify(structuredInput) + "\n"
  : turnParams
    ? turnParams.input.find((item) => item.type === "text").text
    : "";
const args = process.argv.slice(2);
writeFileSync(
  "harness-invocation.json",
  JSON.stringify({
    cwd: process.cwd(),
    args,
    threadParams,
    turnParams,
    prompt,
    inheritedElectron: process.env.ELECTRON_RUN_AS_NODE,
    database: process.env.DATABASE_URL,
  }),
);
const codex = args[0] === "exec" || args[0] === "app-server";
const rawSend = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const outputs = new Map();
const send = (value) => {
  if (!turnParams) {
    rawSend(value);
    return;
  }
  const params = { threadId: session, turnId: turn };
  if (value.type === "thread.started") return;
  if (value.type === "turn.completed") {
    const usage = value.usage ?? {},
      total = {
        inputTokens: usage.input_tokens ?? 0,
        cachedInputTokens: usage.cached_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      };
    rawSend({
      method: "thread/tokenUsage/updated",
      params: { ...params, tokenUsage: { total, last: total } },
    });
    rawSend({
      method: "turn/completed",
      params: { threadId: session, turn: { id: turn, status: "completed" } },
    });
    return;
  }
  if (value.type?.startsWith("item.")) {
    const item = value.item,
      types = {
        agent_message: "agentMessage",
        command_execution: "commandExecution",
        file_change: "fileChange",
        web_search: "webSearch",
        mcp_tool_call: "mcpToolCall",
      };
    if (value.type === "item.updated" && item.type === "command_execution") {
      const previous = outputs.get(item.id) ?? "";
      outputs.set(item.id, item.aggregated_output);
      rawSend({
        method: "item/commandExecution/outputDelta",
        params: {
          ...params,
          itemId: item.id,
          delta: item.aggregated_output.slice(previous.length),
        },
      });
      return;
    }
    rawSend({
      method: value.type === "item.started" ? "item/started" : "item/completed",
      params: {
        ...params,
        item: {
          ...item,
          type: types[item.type] ?? item.type,
          status: item.status ?? (value.type === "item.started" ? "inProgress" : "completed"),
          aggregatedOutput: item.aggregated_output,
          exitCode: item.exit_code,
          changes: item.changes?.map((c) => ({ ...c, kind: { type: c.kind }, diff: c.diff ?? "" })),
        },
      },
    });
    return;
  }
  rawSend(value);
};
if (prompt.includes("structured-failure-fixture")) {
  const code = prompt.match(/structured-failure-fixture ([A-Za-z_]+)/)?.[1] ?? "unknown";
  if (turnParams)
    rawSend({
      method: "turn/completed",
      params: {
        threadId: session,
        turn: {
          id: turn,
          status: "failed",
          error: { message: "This turn could not finish.", codexErrorInfo: code },
        },
      },
    });
  else
    send({
      type: "result",
      subtype: code,
      is_error: false,
      errors: ["This turn could not finish."],
    });
  process.exit(0);
}
if (prompt.includes("provider-retry-fixture")) {
  if (turnParams) {
    rawSend({
      method: "error",
      params: {
        threadId: session,
        turnId: turn,
        willRetry: true,
        error: { message: "Transient failure", codexErrorInfo: "serverOverloaded" },
      },
    });
    send({ type: "turn.completed" });
  } else {
    send({
      type: "assistant",
      error: "rate_limit",
      message: { content: [{ type: "text", text: "Too many requests" }] },
    });
    send({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, error: "rate_limit" });
    send({ type: "result", subtype: "success", is_error: false, result: "Recovered" });
  }
  process.exit(0);
}
if (prompt.includes("provider-failure-fixture")) {
  const message = "This content was flagged for possible cybersecurity risk.";
  if (turnParams) {
    rawSend({
      method: "error",
      params: { threadId: session, turnId: turn, willRetry: false, error: { message } },
    });
    rawSend({
      method: "turn/completed",
      params: { threadId: session, turn: { id: turn, status: "failed" } },
    });
  } else {
    send({
      type: "assistant",
      error: "content_policy",
      message: { content: [{ type: "text", text: message }] },
    });
    send({ type: "result", is_error: true });
  }
  process.exit(0);
}
if (prompt.includes("invalid-event")) {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (prompt.includes("permission-fixture")) {
  const command = prompt.includes("oversized-approval")
    ? `echo ${"x".repeat(17_000)}`
    : prompt.includes("bidi-approval")
      ? "echo \u202espoof\u202c"
      : "touch approved.txt";
  if (codex)
    send({
      type: "item.started",
      item: { id: "permission-command", type: "command_execution", command },
    });
  else
    send({
      type: "assistant",
      message: {
        id: "permission-message",
        content: [
          {
            type: "tool_use",
            id: "permission-command",
            name: "Bash",
            input: { command },
          },
        ],
      },
    });
  const auto = codex
    ? threadParams.approvalPolicy === "never" && threadParams.sandbox === "danger-full-access"
    : args.includes("bypassPermissions");
  let allowed = auto,
    response;
  if (!auto || prompt.includes("force-ask")) {
    rawSend(
      codex
        ? {
            id: "fixture-approval",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: session,
              turnId: turn,
              itemId: "permission-command",
              command,
              cwd: process.cwd(),
              reason: "This action needs permission.",
            },
          }
        : {
            type: "control_request",
            request_id: "fixture-approval",
            request: {
              subtype: "can_use_tool",
              tool_name: "Bash",
              tool_use_id: "permission-command",
              input: { command },
              decision_reason: "This action needs permission.",
            },
          },
    );
    writeFileSync("permission-waiting.json", "{}");
    if (prompt.includes("cancel-request")) {
      rawSend(
        codex
          ? {
              method: "serverRequest/resolved",
              params: { threadId: session, requestId: "fixture-approval" },
            }
          : { type: "control_cancel_request", request_id: "fixture-approval" },
      );
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    while (true) {
      const next = await lines.next();
      if (next.done) process.exit(1);
      response = JSON.parse(next.value);
      if (
        codex
          ? response.id === "fixture-approval"
          : response.response?.request_id === "fixture-approval"
      )
        break;
    }
    writeFileSync("permission-response.json", JSON.stringify(response));
    allowed = codex
      ? ["accept", "acceptForSession"].includes(response.result?.decision)
      : response.response?.response?.behavior === "allow";
  }
  if (allowed) writeFileSync("approved.txt", "approved");
  if (codex)
    send({
      type: "item.completed",
      item: {
        id: "permission-command",
        type: "command_execution",
        command,
        aggregated_output: allowed ? "Created approved.txt" : "Action denied",
        exit_code: allowed ? 0 : 1,
      },
    });
  else
    send({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "permission-command",
            content: allowed ? "Created approved.txt" : "Action denied",
            is_error: !allowed,
          },
        ],
      },
    });
  send(
    codex
      ? {
          type: "item.completed",
          item: {
            id: "response",
            type: "agent_message",
            text: allowed ? "Action approved." : "Action declined.",
          },
        }
      : {
          type: "assistant",
          message: {
            id: "response",
            content: [{ type: "text", text: allowed ? "Action approved." : "Action declined." }],
          },
        },
  );
  send(codex ? { type: "turn.completed" } : { type: "result" });
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
