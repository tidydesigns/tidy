#!/usr/bin/env node
import { createInterface } from "node:readline";
import { strict as assert } from "node:assert";
const claude = process.argv.includes("--input-format");
const opencode = process.argv.includes("acp");
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let promptId: unknown;
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  const method = claude ? value.request?.subtype : value.method;
  const reply = (result: unknown) =>
    send(
      claude
        ? {
            type: "control_response",
            response: { subtype: "success", request_id: value.request_id, response: result },
          }
        : { id: value.id, result },
    );
  if (method === "initialize")
    reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } });
  else if (method === "config/read")
    reply({
      config: {
        mcp_servers: { private: { command: "never-run" } },
        apps: { private: { enabled: true } },
      },
    });
  else if (method === "thread/start") {
    assert.equal(value.params.ephemeral, true);
    assert.equal(value.params.sandbox, "read-only");
    assert.equal(value.params.config.mcp_servers.private.enabled, false);
    assert.equal(value.params.config.apps.private.enabled, false);
    assert.equal(value.params.config["features.shell_tool"], false);
    assert.equal(value.params.threadId, undefined);
    reply({ thread: { id: "ses_naming" } });
  } else if (method === "session/new") {
    assert.deepEqual(value.params.mcpServers, []);
    assert.equal(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!).permission, "deny");
    reply({
      sessionId: "ses_naming",
      configOptions: [{ id: "model", currentValue: "fixture/model" }],
    });
  } else if (
    method === "session/delete" ||
    method === "session/set_model" ||
    method === "session/set_config_option"
  )
    reply({});
  else if (method === "turn/start" || method === "session/prompt" || value.type === "user") {
    if (method === "turn/start") reply({ turn: { id: "naming-turn" } });
    promptId = value.id;
    const prompt = JSON.stringify(claude ? value.message : value.params);
    if (prompt.includes("wait-for-cancel")) continue;
    if (claude) {
      assert.ok(process.argv.includes("--no-session-persistence"));
      assert.equal(process.argv[process.argv.indexOf("--tools") + 1], "");
      send({
        type: "control_request",
        request_id: "forbidden-tool",
        request: { subtype: "can_use_tool", tool_name: "Bash" },
      });
    } else
      send({
        id: "forbidden-tool",
        method: opencode ? "session/request_permission" : "item/commandExecution/requestApproval",
        params: {},
      });
  } else if ((claude ? value.response?.request_id : value.id) === "forbidden-tool") {
    assert.ok(claude ? value.response.subtype === "error" : value.error);
    if (claude) send({ type: "result", result: "Tools disabled", is_error: false });
    else if (opencode) {
      send({
        method: "session/update",
        params: {
          sessionId: "ses_naming",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Tools disabled" },
          },
        },
      });
      send({ id: promptId, result: { stopReason: "end_turn" } });
    } else {
      send({
        method: "item/completed",
        params: {
          threadId: "ses_naming",
          item: { type: "agentMessage", text: "Tools disabled" },
        },
      });
      send({
        method: "turn/completed",
        params: { threadId: "ses_naming", turn: { status: "completed" } },
      });
    }
  }
}
