import { version } from "../../../package.json";
import {
  codexPermissions,
  validatePermissionMode,
  type ApprovalDecision,
} from "../../shared/contracts/permissions";
import { createCodexEvents } from "./codex-events";
import { object, text } from "./harness-transport";
import { plainToolText } from "./tool-events";
import type { AdapterContext, HarnessAdapter } from "./session-types";

export function createCodexAdapter(context: AdapterContext): HarnessAdapter {
  const { input, emit, accepted, complete, ask, cancelApproval } = context;
  const request = context.transport.request.bind(context.transport);
  const write = context.transport.write.bind(context.transport);
  const rejectRequest = context.transport.reject.bind(context.transport);
  const mode = validatePermissionMode(input.harness, input.settings?.permissionMode);
  let threadId: string | undefined, turnId: string | undefined, failure: string | undefined;
  let started = Promise.withResolvers<void>();
  let completedTurnId: string | undefined;
  const filePreviews = new Map<string, string>();
  let codexEvent = createCodexEvents(emit);
  return {
    async initialize() {
      await request("initialize", {
        clientInfo: { name: "tidy_desktop", title: "Tidy", version },
      });
      write({ method: "initialized", params: {} });
      const params = {
        cwd: input.cwd,
        ...codexPermissions(mode),
        model: input.settings?.model ?? null,
        ...(input.settings?.effort || (mode === "default" && input.additionalDirectories?.length)
          ? {
              config: {
                ...(input.settings?.effort
                  ? { model_reasoning_effort: input.settings.effort }
                  : {}),
                ...(mode === "default" && input.additionalDirectories?.length
                  ? { "sandbox_workspace_write.writable_roots": input.additionalDirectories }
                  : {}),
              },
            }
          : {}),
      };
      const response = object(
        await request(input.sessionId ? "thread/resume" : "thread/start", {
          ...params,
          ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
        }),
      );
      threadId = text(object(response.thread).id);
      if (!threadId) throw new Error("Codex did not return a thread identifier.");
      emit({ type: "session", id: threadId });
      if (typeof response.model === "string") emit({ type: "model", model: response.model });
    },
    async submit(message) {
      failure = undefined;
      turnId = undefined;
      filePreviews.clear();
      started = Promise.withResolvers<void>();
      codexEvent = createCodexEvents(emit);
      context.submitting();
      const responseTurn = object(
        await request("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: message.skill
                ? `${message.skill.context}\n\nUser request:\n\n$${message.skill.prompt.slice(1)}`
                : message.prompt,
              text_elements: [],
            },
            ...(message.skill?.invocation.kind === "file"
              ? [
                  {
                    type: "skill",
                    name: message.skill.invocation.name,
                    path: message.skill.invocation.path,
                  },
                ]
              : []),
            ...(message.images ?? []).map((image) => ({ type: "localImage", path: image.path })),
          ],
          ...(input.settings?.effort ? { effort: input.settings.effort } : {}),
        }),
      );
      accepted();
      turnId = text(object(responseTurn.turn).id) || turnId;
    },
    consume(value) {
      const method = text(value.method),
        params = object(value.params);
      if (params.threadId && params.threadId !== threadId) {
        if (value.id !== undefined)
          rejectRequest(value.id, "This request belongs to another thread.");
        return;
      }
      const eventTurnId = text(params.turnId) || text(object(params.turn).id);
      if (eventTurnId && (eventTurnId === completedTurnId || (turnId && eventTurnId !== turnId))) {
        if (value.id !== undefined)
          rejectRequest(value.id, "This request belongs to another turn.");
        return;
      }
      if (!context.isActive()) {
        if (value.id !== undefined) rejectRequest(value.id, "No active turn.");
        return;
      }
      if (value.id !== undefined) {
        if (
          !threadId ||
          params.threadId !== threadId ||
          !text(params.turnId) ||
          !text(params.itemId)
        ) {
          rejectRequest(value.id, "No matching active Tidy thread and turn.");
          return;
        }
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          const command = text(params.command),
            network = object(params.networkApprovalContext);
          const choices: ApprovalDecision[] = ["allow", "allow-session", "deny"];
          if (Array.isArray(params.availableDecisions)) {
            if (!params.availableDecisions.includes("accept"))
              choices.splice(choices.indexOf("allow"), 1);
            if (!params.availableDecisions.includes("acceptForSession"))
              choices.splice(choices.indexOf("allow-session"), 1);
          }
          ask(
            value.id,
            method.includes("fileChange")
              ? "Allow file changes?"
              : network.host
                ? `Allow network access to ${text(network.host)}?`
                : "Allow command?",
            text(params.reason),
            [
              command,
              filePreviews.has(text(params.itemId)) ? filePreviews.get(text(params.itemId))! : "",
              text(params.cwd) && `Directory: ${text(params.cwd)}`,
              text(params.grantRoot) && `Write access: ${text(params.grantRoot)}`,
              network.host && JSON.stringify(network),
            ]
              .filter(Boolean)
              .join("\n"),
            choices,
            (decision) => ({
              decision:
                decision === "allow"
                  ? "accept"
                  : decision === "allow-session"
                    ? "acceptForSession"
                    : "decline",
            }),
          );
        } else if (method === "item/permissions/requestApproval") {
          const requested = object(params.permissions);
          const granted = {
            ...(requested.network ? { network: requested.network } : {}),
            ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
          };
          ask(
            value.id,
            "Allow additional access?",
            text(params.reason),
            { cwd: params.cwd, permissions: requested },
            ["allow", "allow-session", "deny"],
            (decision) => ({
              permissions: decision === "deny" ? {} : granted,
              scope: decision === "allow-session" ? "session" : "turn",
            }),
            "turn",
          );
        } else rejectRequest(value.id, "This interactive request is not supported in Tidy yet.");
        return;
      }
      if (method === "serverRequest/resolved") cancelApproval(params.requestId);
      if (method === "turn/started") {
        accepted();
        turnId = text(object(params.turn).id) || turnId;
        started.resolve();
      }
      const item = object(params.item);
      if (method === "item/started" && item.type === "fileChange" && filePreviews.size < 1000)
        filePreviews.set(
          text(item.id),
          plainToolText(JSON.stringify(item.changes) ?? "").slice(0, 16_001),
        );
      codexEvent(method, params);
      if (method === "item/completed") filePreviews.delete(text(item.id));
      if (method === "error" && !params.willRetry)
        failure = text(object(params.error).message) || "Codex could not complete this turn.";
      if (method === "turn/completed") {
        const turn = object(params.turn);
        completedTurnId = text(turn.id) || turnId;

        if (turn.status === "failed")
          failure = text(object(turn.error).message) || "Codex could not complete this turn.";
        if (turn.status === "interrupted") failure = "The harness turn was interrupted.";
        complete(failure ? new Error(failure) : undefined);
      }
    },
    async interrupt() {
      await started.promise;
      if (threadId && turnId) await request("turn/interrupt", { threadId, turnId });
    },
    async steer(message) {
      if (!context.isActive() || !threadId || !turnId) return false;
      await request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [
          {
            type: "text",
            text: message.skill
              ? `${message.skill.context}\n\nUser request:\n\n$${message.skill.prompt.slice(1)}`
              : message.prompt,
            text_elements: [],
          },
          ...(message.skill?.invocation.kind === "file"
            ? [
                {
                  type: "skill",
                  name: message.skill.invocation.name,
                  path: message.skill.invocation.path,
                },
              ]
            : []),
          ...(message.images ?? []).map((image) => ({ type: "localImage", path: image.path })),
        ],
      });
      return true;
    },
  };
}
