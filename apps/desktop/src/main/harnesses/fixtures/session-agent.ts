#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
const record = z.record(z.string(), z.unknown());
const object = (input: unknown) => record.parse(input ?? {});
const claude = process.argv.includes("--input-format");
const acp = process.argv.includes("acp");
const sessionId = acp ? "ses_fixture" : "b56ba7bb-00aa-4a56-a64c-593c3c377dcc";
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let sequence = 0;
let promptId: unknown;
let turnId = "";
let pendingApproval = false;
let stubborn = false;
let nativeStarted = false;
function reply(value: unknown, result: unknown) {
  const request = object(value);
  send(
    claude
      ? {
          type: "control_response",
          response: { subtype: "success", request_id: request.request_id, response: result },
        }
      : { id: request.id, result },
  );
}
function finish(cancelled = false) {
  if (acp)
    send({
      id: promptId,
      result: {
        stopReason: cancelled ? "cancelled" : "end_turn",
        usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 20, thoughtTokens: 3 },
      },
    });
  else if (claude)
    send({ type: "result", session_id: sessionId, result: cancelled ? "" : "OK", is_error: false });
  else
    send({
      method: "turn/completed",
      params: {
        threadId: sessionId,
        turn: { id: turnId, status: cancelled ? "interrupted" : "completed" },
      },
    });
}
for await (const line of createInterface({ input: process.stdin })) {
  const value = object(JSON.parse(line));
  const method = claude ? object(value.request).subtype : value.method;
  appendFileSync(
    "session-events.jsonl",
    JSON.stringify({ pid: process.pid, method, type: value.type, value }) + "\n",
  );
  if (method === "initialize") reply(value, { agentCapabilities: { loadSession: true } });
  else if (method === "thread/start" || method === "thread/resume")
    reply(value, { thread: { id: sessionId } });
  else if (method === "session/new" || method === "session/load") {
    if (method === "session/load")
      send({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Old response" },
          },
        },
      });
    reply(value, {
      ...(method === "session/new" ? { sessionId } : {}),
      configOptions: [
        {
          id: "model",
          currentValue: "fixture/model",
          options: [{ value: "fixture/model", name: "Fixture" }],
        },
      ],
    });
  } else if (method === "session/set_config_option" || method === "session/set_model")
    reply(value, {});
  else if (method === "turn/interrupt" || method === "interrupt" || method === "session/cancel") {
    if (stubborn) continue;
    if (!claude && !acp && !nativeStarted) {
      send({ id: value.id, error: { message: "no active turn to interrupt" } });
      continue;
    }
    if (method !== "session/cancel") reply(value, {});
    pendingApproval = false;
    finish(true);
  } else if (method === "turn/start" || method === "session/prompt" || value.type === "user") {
    nativeStarted = false;
    sequence++;
    turnId = `turn-${sequence}`;
    promptId = value.id;
    const params = object(value.params);
    const prompt = JSON.stringify(claude ? value.message : (params.input ?? params.prompt));
    stubborn = prompt.includes("stubborn");
    if (prompt.includes("crash")) process.exit(1);
    if (acp)
      send({
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
        },
      });
    else if (claude) send({ type: "system", subtype: "init", session_id: sessionId });
    else {
      reply(value, { turn: { id: turnId } });
      const begin = () => {
        nativeStarted = true;
        send({ method: "turn/started", params: { threadId: sessionId, turn: { id: turnId } } });
      };
      if (prompt.includes("early-stop")) setTimeout(begin, 20);
      else begin();
    }
    if (prompt.includes("approve")) {
      pendingApproval = true;
      if (acp)
        send({
          id: "approval",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { title: "Write file", rawInput: { path: "output.txt" } },
            options: [
              { optionId: "once", kind: "allow_once" },
              { optionId: "always", kind: "allow_always" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
      else if (claude)
        send({
          type: "control_request",
          request_id: "approval",
          request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "output.txt" } },
        });
      else
        send({
          id: "approval",
          method: "item/commandExecution/requestApproval",
          params: { threadId: sessionId, turnId, itemId: "command", command: "write output.txt" },
        });
    } else if (!prompt.includes("hold") && !stubborn) {
      if (claude)
        send({
          type: "assistant",
          session_id: sessionId,
          message: { id: `message-${sequence}`, content: [{ type: "text", text: "OK" }] },
        });
      else if (!acp)
        send({
          method: "item/agentMessage/delta",
          params: { threadId: sessionId, turnId, itemId: `message-${sequence}`, delta: "OK" },
        });
      finish();
    }
  } else if (
    pendingApproval &&
    (value.id === "approval" || object(value.response).request_id === "approval")
  ) {
    pendingApproval = false;
    finish();
  }
}
