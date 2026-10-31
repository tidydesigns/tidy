import { claudeAccountUsage } from "./usage-state";
import { skillCommand } from "../../shared/contracts/skills";
import { z } from "zod";
import { createClaudeParser } from "./harnesses";
import { HarnessNotSubmittedError, object, text } from "./harness-transport";
import type { AdapterContext, HarnessAdapter } from "./session-types";

const taskStatus = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
  "killed",
]);
const taskEvent = z
  .object({
    type: z.literal("system"),
    session_id: z.string().optional(),
    task_id: z.string().min(1).max(512),
  })
  .and(
    z.discriminatedUnion("subtype", [
      z.object({ subtype: z.enum(["task_started", "task_progress"]) }),
      z.object({
        subtype: z.literal("task_notification"),
        status: z.enum(["completed", "failed", "stopped"]),
      }),
      z.object({
        subtype: z.literal("task_updated"),
        status: taskStatus.optional(),
        patch: z.object({ status: taskStatus.optional() }),
      }),
    ]),
  );

export function createClaudeAdapter(context: AdapterContext): HarnessAdapter {
  const { input, ask, cancelApproval, complete } = context;
  const write = context.transport.write.bind(context.transport);
  const rejectRequest = context.transport.reject.bind(context.transport);
  let sessionId = input.sessionId;
  const emit: typeof context.emit = (update) => {
    if (update.type === "session") sessionId = update.id;
    context.emit(update);
  };
  let parse: ReturnType<typeof createClaudeParser> | undefined;
  return {
    async initialize() {
      claudeAccountUsage(await context.transport.request("initialize"), input.cwd);
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
      const task = value.type === "system" ? taskEvent.safeParse(value) : undefined;
      if (task?.success) {
        const event = task.data;
        if (event.session_id && sessionId && event.session_id !== sessionId) return;
        const status =
          event.subtype === "task_updated"
            ? (event.patch.status ?? event.status)
            : event.subtype === "task_notification"
              ? event.status
              : undefined;
        context.activity({
          id: event.task_id,
          state:
            event.subtype === "task_started" ||
            status === "running" ||
            status === "pending" ||
            status === "paused"
              ? "started"
              : event.subtype === "task_notification" ||
                  status === "completed" ||
                  status === "failed" ||
                  status === "stopped" ||
                  status === "killed"
                ? "finished"
                : "progress",
        });
        return;
      }
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
      context.activity();
      if (value.type === "system" && value.subtype === "init") context.accepted();
      parse?.(value);
      if (value.type === "result") {
        parse = undefined;
        complete();
      }
    },
    async interrupt() {
      await context.transport.request("interrupt");
    },
  };
}
