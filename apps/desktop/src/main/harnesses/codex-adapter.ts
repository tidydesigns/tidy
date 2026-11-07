import { skillInvocationPrompt } from "../../shared/contracts/skills";
import { codexFailure, HarnessFailureError } from "./provider-failure";
import { version } from "../../../package.json";
import { z } from "zod";
import {
  codexPermissions,
  validatePermissionMode,
  type ApprovalDecision,
} from "../../shared/contracts/permissions";
import { createCodexEvents } from "./codex-events";
import { HarnessNotSubmittedError, object, text } from "./harness-transport";
import { plainToolText } from "./tool-events";
import type { AdapterContext, HarnessAdapter, TurnInput } from "./session-types";

const workId = z.string().min(1).max(512);
const workItem = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["commandExecution", "mcpToolCall", "dynamicToolCall"]),
    id: workId,
    status: z.enum(["inProgress", "completed", "failed", "declined"]).optional(),
  }),
  z.object({
    type: z.literal("collabAgentToolCall"),
    agentsStates: z.record(
      workId,
      z.object({
        status: z.enum([
          "pendingInit",
          "running",
          "interrupted",
          "completed",
          "errored",
          "shutdown",
          "notFound",
        ]),
      }),
    ),
  }),
  z.object({
    type: z.literal("subAgentActivity"),
    agentThreadId: workId,
    kind: z.enum(["started", "interacted", "interrupted", "completed"]),
  }),
]);
const workEvent = z.object({ threadId: workId, turnId: workId, item: workItem });
const threadStatus = z.object({
  threadId: workId,
  status: z.object({ type: z.enum(["active", "idle", "notLoaded", "systemError"]) }),
});
const modelDefaults = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      isDefault: z.boolean().optional(),
      defaultReasoningEffort: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullish(),
});

function codexInput(message: Pick<TurnInput, "prompt" | "skill" | "images">) {
  return [
    {
      type: "text",
      text: message.skill
        ? `${message.skill.context}\n\nUser request:\n\n${skillInvocationPrompt(message.skill.prompt, "$", message.skill.invocation.name)}`
        : message.prompt,
      text_elements: [],
    },
    ...(message.skill
      ? [message.skill.invocation, ...(message.skill.additional ?? [])].flatMap((invocation) =>
          invocation.kind === "file"
            ? [
                {
                  type: "skill",
                  name: invocation.name,
                  path: invocation.path,
                },
              ]
            : [],
        )
      : []),
    ...(message.images ?? []).map((image) => ({ type: "localImage", path: image.path })),
  ];
}

export function createCodexAdapter(context: AdapterContext): HarnessAdapter {
  const { input, emit, accepted, complete, ask, cancelApproval } = context;
  const request = context.transport.request.bind(context.transport);
  const write = context.transport.write.bind(context.transport);
  const rejectRequest = context.transport.reject.bind(context.transport);
  let mode = validatePermissionMode(input.harness, input.settings?.permissionMode);
  let threadId: string | undefined,
    turnId: string | undefined,
    failure: HarnessFailureError | undefined;
  let started = Promise.withResolvers<void>();
  const completedTurns = new Set<string>();
  let appliedSettings = input.settings ?? {};
  let currentModel: string | undefined;
  let acceptTurn = () => {};
  // Omitted turn overrides inherit the previous turn. Resolve defaults explicitly
  // when an override is removed, so the composer never silently keeps an old value.
  const turnSettings = async (
    settings: NonNullable<TurnInput["settings"]>,
    signal: AbortSignal,
  ) => {
    let model = settings.model;
    let effort = settings.effort;
    const resetModel = !model && !!appliedSettings.model;
    const resetEffort =
      !effort && (!!appliedSettings.effort || settings.model !== appliedSettings.model);
    if (resetModel || resetEffort) {
      const config = object(
        object(await request("config/read", { includeLayers: false, cwd: input.cwd })).config,
      );
      signal.throwIfAborted();
      if (resetModel) model = text(config.model) || undefined;
      if (resetEffort) effort = text(config.model_reasoning_effort) || undefined;
      const unresolved = () => (resetModel && !model) || (resetEffort && !effort);
      let cursor: string | null | undefined;
      const cursors = new Set<string>();
      while (unresolved()) {
        const result = modelDefaults.parse(
          await request("model/list", { limit: 100, includeHidden: true, cursor }),
        );
        signal.throwIfAborted();
        if (resetModel) model ||= result.data.find((item) => item.isDefault)?.model;
        if (resetEffort && (!resetModel || model))
          effort ||= result.data.find(
            (item) => item.model === (model ?? currentModel),
          )?.defaultReasoningEffort;
        cursor = result.nextCursor;
        if (!cursor || cursors.has(cursor)) break;
        cursors.add(cursor);
      }
      if (unresolved())
        throw new HarnessNotSubmittedError(
          "Codex did not report its default model or reasoning effort. Choose a model and effort to continue.",
        );
    }
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  };
  const filePreviews = new Map<string, string>();
  const agents = new Set<string>();
  const agentActivity = (id: string, state: "started" | "progress" | "finished") => {
    if (state === "started" && agents.size < 1000) agents.add(id);
    if (state === "finished") agents.delete(id);
    context.activity({ id: `agent:${id}`, state });
  };
  let codexEvent: ReturnType<typeof createCodexEvents> | undefined;
  // Only unfinished tools retain their originating parser and turn callback.
  const pendingTools = new Map<string, ReturnType<typeof createCodexEvents>>();
  return {
    async initialize() {
      await request("initialize", {
        clientInfo: { name: "tidy_desktop", title: "Tidy", version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      write({ method: "initialized", params: {} });
      const params = {
        cwd: input.cwd,
        ...codexPermissions(mode),
        model: input.settings?.model ?? null,
        ...(input.settings?.fastMode !== undefined
          ? { serviceTier: input.settings.fastMode ? "priority" : "default" }
          : {}),
        ...(input.settings?.effort ||
        ((mode === "default" || mode === "provider-auto") && input.additionalDirectories?.length)
          ? {
              config: {
                ...(input.settings?.effort
                  ? { model_reasoning_effort: input.settings.effort }
                  : {}),
                ...((mode === "default" || mode === "provider-auto") &&
                input.additionalDirectories?.length
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
      currentModel = text(response.model) || input.settings?.model;
      if (currentModel) emit({ type: "model", model: currentModel });
    },
    async setPermissionMode(next) {
      const previous = codexPermissions(mode),
        permissions = codexPermissions(next);
      // The live-turn API can update the reviewer, but cannot replace its sandbox
      // or approval policy. Those changes need a fresh native session.
      if (
        !threadId ||
        previous.sandbox !== permissions.sandbox ||
        previous.approvalPolicy !== permissions.approvalPolicy
      )
        return false;
      const active = context.isActive();
      const target = turnId;
      if (active && !target) return false;
      await request(
        "thread/settings/update",
        {
          threadId,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
        },
        2000,
      );
      if (active) {
        const response = object(
          await request(
            "turn/settings/update",
            {
              threadId,
              turnId: target,
              approvalsReviewer: permissions.approvalsReviewer,
            },
            2000,
          ),
        );
        if (response.status !== "applied") return false;
      }
      mode = next;
      return true;
    },
    async submit(message, signal) {
      failure = undefined;
      turnId = undefined;
      filePreviews.clear();
      started = Promise.withResolvers<void>();
      codexEvent = createCodexEvents(context.turnEmitter());
      const settings = message.settings ?? input.settings ?? {};
      const overrides = await turnSettings(settings, signal);
      signal.throwIfAborted();
      let applied = false;
      const accept = () => {
        if (applied || signal.aborted) return;
        applied = true;
        appliedSettings = { ...settings };
        if (overrides.model && overrides.model !== currentModel) {
          currentModel = overrides.model;
          emit({ type: "model", model: currentModel });
        }
        accepted();
      };
      acceptTurn = accept;
      context.submitting();
      const responseTurn = object(
        await request("turn/start", {
          threadId,
          input: codexInput(message),
          ...overrides,
          ...(input.settings?.fastMode !== undefined
            ? { serviceTier: input.settings.fastMode ? "priority" : "default" }
            : {}),
        }),
      );
      if (signal.aborted) return;
      accept();
      turnId = text(object(responseTurn.turn).id) || turnId;
    },
    consume(value) {
      const method = text(value.method),
        params = object(value.params);
      if (value.id === undefined && method === "thread/status/changed") {
        const parsed = threadStatus.safeParse(params);
        if (parsed.success && agents.has(parsed.data.threadId)) {
          agentActivity(
            parsed.data.threadId,
            parsed.data.status.type === "active" ? "progress" : "finished",
          );
          return;
        }
      }
      if (params.threadId && params.threadId !== threadId) {
        if (value.id !== undefined)
          rejectRequest(value.id, "This request belongs to another thread.");
        return;
      }
      const eventTurnId = text(params.turnId) || text(object(params.turn).id);
      const itemId = text(object(params.item).id) || text(params.itemId);
      const toolKey = `${eventTurnId || turnId}:${itemId}`;
      const toolOwner = pendingTools.get(toolKey);
      const oldTurn =
        !context.isActive() ||
        Boolean(
          (eventTurnId &&
            (completedTurns.has(eventTurnId) || (turnId && eventTurnId !== turnId))) ||
          (toolOwner && toolOwner !== codexEvent),
        );
      if (value.id === undefined && oldTurn && params.threadId === threadId) {
        const parser = pendingTools.get(toolKey);
        if (
          parser &&
          (method === "item/completed" || method === "item/commandExecution/outputDelta")
        ) {
          parser(method, params);
          if (method === "item/completed") pendingTools.delete(toolKey);
        }
      }
      if (value.id === undefined && threadId && params.threadId === threadId) {
        context.activity();
        if (method === "item/started" || method === "item/completed") {
          const parsed = workEvent.safeParse(params);
          if (parsed.success) {
            const item = parsed.data.item;
            if (item.type === "collabAgentToolCall") {
              for (const [id, agent] of Object.entries(item.agentsStates))
                agentActivity(
                  id,
                  agent.status === "running" || agent.status === "pendingInit"
                    ? "started"
                    : "finished",
                );
            } else if (item.type === "subAgentActivity") {
              agentActivity(
                item.agentThreadId,
                item.kind === "started"
                  ? "started"
                  : item.kind === "interacted"
                    ? "progress"
                    : "finished",
              );
            } else if (!oldTurn || method === "item/completed") {
              context.activity({
                id: `tool:${parsed.data.turnId}:${item.id}`,
                state:
                  method === "item/completed" || (item.status && item.status !== "inProgress")
                    ? "finished"
                    : "started",
              });
            }
          }
        }
      }
      if (oldTurn) {
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
              filePreviews.get(text(params.itemId)) ?? "",
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
        acceptTurn();
        turnId = text(object(params.turn).id) || turnId;
        started.resolve();
      }
      const item = object(params.item);
      if (method === "item/started" && item.type === "fileChange" && filePreviews.size < 1000)
        filePreviews.set(
          text(item.id),
          plainToolText(JSON.stringify(item.changes) ?? "").slice(0, 16_001),
        );
      if (
        method === "item/started" &&
        codexEvent &&
        itemId &&
        ["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"].includes(
          text(item.type),
        ) &&
        pendingTools.size < 1000
      )
        pendingTools.set(toolKey, codexEvent);
      codexEvent?.(method, params);
      if (method === "item/completed") pendingTools.delete(toolKey);
      if (method === "item/completed") filePreviews.delete(text(item.id));
      if (method === "error" && !params.willRetry) failure = codexFailure(params.error);
      if (method === "turn/completed") {
        acceptTurn();
        const turn = object(params.turn);
        const completedId = text(turn.id) || turnId;
        if (completedId) {
          completedTurns.add(completedId);
          if (completedTurns.size > 1000)
            completedTurns.delete(completedTurns.values().next().value!);
        }

        if (turn.status === "failed") {
          const error = codexFailure(turn.error);
          if (!failure) failure = error;
          else if (failure.kind === "unknown")
            failure = new HarnessFailureError(failure.message, error.kind);
        }
        if (turn.status === "interrupted")
          failure = new HarnessFailureError("The harness turn was interrupted.");
        codexEvent = undefined;
        filePreviews.clear();
        complete(failure);
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
        input: codexInput(message),
      });
      return true;
    },
  };
}
