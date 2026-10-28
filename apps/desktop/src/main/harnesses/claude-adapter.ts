import { skillCommand } from "../../shared/contracts/skills";
import { createClaudeParser } from "./harnesses";
import { HarnessNotSubmittedError, object, text } from "./harness-transport";
import type { AdapterContext, HarnessAdapter } from "./session-types";

export function createClaudeAdapter(context: AdapterContext): HarnessAdapter {
  const { input, ask, cancelApproval, complete } = context;
  const write = context.transport.write.bind(context.transport);
  const rejectRequest = context.transport.reject.bind(context.transport);
  let sessionId = input.sessionId;
  const emit: typeof context.emit = (update) => {
    if (update.type === "session") sessionId = update.id;
    context.emit(update);
  };
  let parse = createClaudeParser(emit);
  return {
    async initialize() {
      await context.transport.request("initialize");
    },
    async submit(message) {
      parse = createClaudeParser(emit);
      context.submitting();
      if (
        !write({
          type: "user",
          session_id: sessionId ?? "",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              ...(message.skill?.invocation.kind === "command"
                ? [
                    { type: "text", text: message.skill.context },
                    {
                      type: "text",
                      text: `/${message.skill.invocation.name}${message.skill.prompt.slice(skillCommand(message.skill.prompt)?.end ?? 0)}`,
                    },
                  ]
                : [{ type: "text", text: message.prompt }]),
              ...(message.images ?? []).map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mimeType, data: image.data },
              })),
            ],
          },
        })
      ) {
        throw new HarnessNotSubmittedError("The harness connection closed.");
      }
    },
    consume(value) {
      if (value.type === "control_cancel_request") {
        cancelApproval(value.request_id);
        return;
      }
      if (value.type === "control_request") {
        if (!context.isActive()) {
          rejectRequest(value.request_id, "No active turn.");
          return;
        }
        const request = object(value.request);
        if (request.subtype !== "can_use_tool") {
          rejectRequest(value.request_id, "This interactive request is not supported in Tidy yet.");
          return;
        }
        if (request.tool_name === "AskUserQuestion") {
          rejectRequest(
            value.request_id,
            "Ask the user in the conversation instead; interactive question forms are not supported yet.",
          );
          return;
        }
        ask(
          value.request_id,
          text(request.title) ||
            `Allow ${text(request.display_name) || text(request.tool_name) || "tool"}?`,
          text(request.decision_reason) || text(request.description),
          {
            ...object(request.input),
            ...(request.blocked_path ? { blocked_path: request.blocked_path } : {}),
          },
          ["allow", "deny"],
          (decision) =>
            decision === "deny"
              ? { behavior: "deny", message: "The user declined this action in Tidy." }
              : {
                  behavior: "allow",
                  updatedInput: object(request.input),
                  toolUseID: request.tool_use_id,
                },
        );
        return;
      }
      if (!context.isActive()) return;
      if (value.type === "system" && value.subtype === "init") context.accepted();
      parse(value);
      if (value.type === "result") {
        complete();
      }
    },
    async interrupt() {
      await context.transport.request("interrupt");
    },
  };
}
