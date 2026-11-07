#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
const record = z.record(z.string(), z.unknown());
const object = (input: unknown) => record.parse(input ?? {});
const claude = process.argv.includes("--input-format");
const acp = process.argv.includes("acp");
if (existsSync("record-startup"))
  appendFileSync(
    "session-startups.jsonl",
    JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\n",
  );
const sessionId = acp ? "ses_fixture" : "b56ba7bb-00aa-4a56-a64c-593c3c377dcc";
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const defaults = () =>
  existsSync("codex-defaults.json")
    ? object(JSON.parse(readFileSync("codex-defaults.json", "utf8")))
    : {};
function cost(amount: number) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } },
    },
  });
}
let sequence = 0;
let promptId: unknown;
let deferredPrompt: { id: unknown; rejected: boolean } | undefined;
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
function background(state: "started" | "progress" | "finished", id: string, ownerTurn = turnId) {
  const ownerSession = id.startsWith("foreign-") ? "ses_other" : sessionId;
  if (acp)
    send({
      method: "session/update",
      params: {
        sessionId: ownerSession,
        update: {
          sessionUpdate: state === "started" ? "tool_call" : "tool_call_update",
          toolCallId: id,
          status: state === "finished" ? "completed" : "in_progress",
          kind: "execute",
        },
      },
    });
  else if (claude)
    send({
      type: "system",
      subtype:
        state === "started"
          ? "task_started"
          : state === "finished"
            ? "task_updated"
            : "task_progress",
      session_id: ownerSession,
      task_id: id,
      tool_use_id: id,
      ...(state === "finished" ? { patch: { status: "killed" } } : {}),
    });
  else if (id.startsWith("agent-"))
    send(
      state === "started"
        ? {
            method: "item/completed",
            params: {
              threadId: ownerSession,
              turnId: ownerTurn,
              item: {
                type: "collabAgentToolCall",
                id,
                tool: "spawnAgent",
                status: "completed",
                senderThreadId: sessionId,
                receiverThreadIds: [id],
                agentsStates: { [id]: { status: "running" } },
              },
            },
          }
        : {
            method: "thread/status/changed",
            params: {
              threadId: id,
              status: { type: state === "finished" ? "idle" : "active", activeFlags: [] },
            },
          },
    );
  else
    send({
      method:
        state === "progress"
          ? "item/commandExecution/outputDelta"
          : state === "started"
            ? "item/started"
            : "item/completed",
      params: {
        threadId: ownerSession,
        turnId: ownerTurn,
        ...(state === "progress" ? { itemId: id, delta: `output:${ownerTurn}` } : {}),
        item: {
          type: "commandExecution",
          id,
          status: state === "finished" ? "completed" : "inProgress",
        },
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
  if (method === "initialize")
    reply(value, {
      agentCapabilities: {
        loadSession: !existsSync("no-load-capability"),
        mcpCapabilities: { http: true },
        ...(existsSync("delete-capability") ? { sessionCapabilities: { delete: {} } } : {}),
      },
    });
  else if (
    ["set_permission_mode", "thread/settings/update", "turn/settings/update"].includes(
      String(method),
    )
  ) {
    if (claude && existsSync("reject-live-permissions")) {
      send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: value.request_id,
          error: "Cannot set permission mode to auto: auto mode unavailable for this model",
        },
      });
    } else if (existsSync("live-permissions")) {
      if (existsSync("slow-live-permissions"))
        await new Promise((resolve) => setTimeout(resolve, 150));
      reply(value, method === "turn/settings/update" ? { status: "applied" } : {});
    } else if (claude)
      send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: value.request_id,
          error: "Live permissions unsupported",
        },
      });
    else send({ id: value.id, error: { code: -32601, message: "Live permissions unsupported" } });
  } else if (method === "thread/start" || method === "thread/resume")
    reply(value, {
      thread: { id: sessionId },
      model: object(value.params).model ?? "fixture/default",
    });
  else if (method === "config/read") {
    const configured = defaults();
    const response = { config: configured.config ?? {} };
    if (typeof configured.delay === "number")
      setTimeout(() => reply(value, response), configured.delay);
    else reply(value, response);
  } else if (method === "model/list") {
    const pages = defaults().pages;
    reply(
      value,
      Array.isArray(pages)
        ? pages[Number(object(value.params).cursor ?? 0)]
        : {
            data: [
              { model: "fixture/default", isDefault: true, defaultReasoningEffort: "medium" },
              { model: "fixture/other", defaultReasoningEffort: "low" },
            ],
            nextCursor: null,
          },
    );
  } else if (method === "session/new" || method === "session/load") {
    if (method === "session/load" && existsSync("replay-cost")) cost(0.25);
    if (method === "session/load" && existsSync("replay-tools")) {
      background("started", "lifecycle-pending");
      background("started", "lifecycle-1");
      background("finished", "lifecycle-1");
    }
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
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "review", description: "Review changes" },
            { name: "deploy.prod", description: "Invalid name" },
            null,
          ],
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
  } else if (method === "session/delete") reply(value, {});
  else if (method === "session/set_config_option" || method === "session/set_model")
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
    if (method === "turn/start" && object(value.params).model === "fixture/rejected") {
      send({ id: value.id, error: { code: -32602, message: "Model unavailable" } });
      continue;
    }
    nativeStarted = false;
    sequence++;
    turnId = `turn-${sequence}`;
    promptId = value.id;
    const params = object(value.params);
    // Fixture commands belong to the user's request, not injected tool instructions.
    const content = claude ? object(value.message).content : (params.input ?? params.prompt);
    const texts = (Array.isArray(content) ? content : [content]).flatMap((part) => {
      if (typeof part === "string") return [part];
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
        return [part.text];
      return [];
    });
    const prompt = texts.map((text) => text.split("\n\nUser request:\n\n").at(-1)).join("\n");
    stubborn = prompt.includes("stubborn");
    if (prompt.includes("crash")) process.exit(1);
    if (acp && prompt.includes("priced")) cost(prompt.includes("follow-up") ? 0.5 : 0.25);
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
      const response = { turn: { id: turnId } };
      const begin = () => {
        nativeStarted = true;
        send({ method: "turn/started", params: { threadId: sessionId, turn: { id: turnId } } });
      };
      if (prompt.includes("delayed-accept")) {
        const waiting = setInterval(() => {
          if (!existsSync("accept-turn")) return;
          clearInterval(waiting);
          reply(value, response);
          begin();
        }, 5);
      } else {
        if (prompt.includes("delayed-ack")) setTimeout(() => reply(value, response), 50);
        else reply(value, response);
        if (prompt.includes("early-stop")) setTimeout(begin, 20);
        else begin();
      }
    }
    if (prompt === "lifecycle-owner" || prompt === "lifecycle-reused-id") {
      background("started", "reused-tool", turnId);
      if (prompt === "lifecycle-reused-id") {
        background("progress", "reused-tool", "turn-1");
        background("finished", "reused-tool", "turn-1");
        // Only Codex includes a turn ID to distinguish a new call with the same ID.
        if (!claude && !acp) background("finished", "reused-tool", turnId);
      }
      finish();
      continue;
    }
    if (prompt === "lifecycle-step" || prompt === "lifecycle-release") {
      if (sequence === 1) background("started", "lifecycle-pending", turnId);
      if (prompt === "lifecycle-release") background("finished", "lifecycle-pending", "turn-1");
      else {
        const id = `lifecycle-${sequence}`;
        background("started", id, turnId);
        background("finished", id, turnId);
      }
      finish();
      continue;
    }
    if (acp && prompt.startsWith("defer-prompt-response ")) {
      deferredPrompt = { id: promptId, rejected: prompt.endsWith("rejected") };
      continue;
    }
    if (acp && prompt === "release-prompt-response" && deferredPrompt) {
      send(
        deferredPrompt.rejected
          ? { id: deferredPrompt.id, error: { code: -32603, message: "Old prompt failed" } }
          : { id: deferredPrompt.id, result: { stopReason: 123 } },
      );
      deferredPrompt = undefined;
    }
    const failureCode = prompt.match(/structured-failure-fixture ([A-Za-z_]+)/)?.[1];
    if (failureCode || prompt.includes("provider-failure-fixture")) {
      const message = failureCode
        ? "This turn could not finish."
        : "This content was flagged for possible cybersecurity risk.";
      if (claude) {
        if (!failureCode)
          send({
            type: "assistant",
            error: "content_policy",
            message: { content: [{ type: "text", text: message }] },
          });
        send({
          type: "result",
          subtype: failureCode,
          is_error: !failureCode,
          errors: failureCode ? [message] : undefined,
        });
      } else {
        if (!failureCode)
          send({
            method: "error",
            params: { threadId: sessionId, turnId, willRetry: false, error: { message } },
          });
        send({
          method: "turn/completed",
          params: {
            threadId: sessionId,
            turn: {
              id: turnId,
              status: "failed",
              error: failureCode ? { message, codexErrorInfo: failureCode } : undefined,
            },
          },
        });
      }
      continue;
    }
    if (prompt.includes("provider-retry-fixture")) {
      if (claude) {
        send({
          type: "assistant",
          error: "rate_limit",
          message: { content: [{ type: "text", text: "Too many requests" }] },
        });
        send({ type: "system", subtype: "api_retry", error: "rate_limit" });
      } else
        send({
          method: "error",
          params: {
            threadId: sessionId,
            turnId,
            willRetry: true,
            error: { message: "Transient failure", codexErrorInfo: "serverOverloaded" },
          },
        });
      finish();
      continue;
    }
    if (prompt.includes("slow-exit"))
      process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150));
    if (prompt.includes("background")) {
      const id = `${prompt.includes("foreign") ? "foreign" : prompt.includes("agent") ? "agent" : "background"}-${sequence}`;
      const ownerTurn = turnId;
      background("started", id, ownerTurn);
      if (claude) background("started", `${id}-secondary`, ownerTurn);
      if (!prompt.includes("silent")) {
        const progress = setInterval(() => background("progress", id, ownerTurn), 50);
        setTimeout(() => {
          clearInterval(progress);
          background("finished", id, ownerTurn);
          if (!claude && !acp && prompt.includes("fail-turn")) {
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: sessionId,
                turnId: ownerTurn,
                itemId: "late-message",
                delta: "must not leak",
              },
            });
            send({
              method: "error",
              params: {
                threadId: sessionId,
                turnId: ownerTurn,
                error: { message: "must not leak" },
                willRetry: false,
              },
            });
            send({
              id: "late-approval",
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: sessionId,
                turnId: ownerTurn,
                itemId: id,
                command: "must not leak",
              },
            });
          }
          if (claude) {
            send({
              type: "system",
              subtype: "task_notification",
              session_id: sessionId,
              task_id: `${id}-secondary`,
              status: "completed",
            });
            background("progress", id, ownerTurn);
            send({
              type: "system",
              subtype: "task_updated",
              session_id: sessionId,
              task_id: id,
              patch: { status: "running" },
            });
          }
        }, 500);
      }
    }
    if (prompt.includes("fail-turn")) {
      if (acp) send({ id: promptId, error: { code: -32603, message: "Turn failed" } });
      else if (claude)
        send({ type: "result", session_id: sessionId, result: "Turn failed", is_error: true });
      else
        send({
          method: "turn/completed",
          params: {
            threadId: sessionId,
            turn: { id: turnId, status: "failed", error: { message: "Turn failed" } },
          },
        });
      continue;
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
