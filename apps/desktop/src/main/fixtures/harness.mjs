#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

if (process.argv.includes("login") && process.argv.includes("status")) process.exit(0);
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}

let prompt = "";
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
  send({ type: "turn.completed", usage: {} });
} else {
  send({ type: "system", session_id: session });
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
  send({ type: "result", session_id: session, result: "Hello project", is_error: false });
}
