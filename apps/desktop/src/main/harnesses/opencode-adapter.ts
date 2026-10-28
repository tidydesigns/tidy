import { z } from "zod";
import { nativeSessionIdSchema } from "../../shared/contracts/desktop";
import type { ApprovalDecision } from "../../shared/contracts/permissions";
import { skillCommand } from "../../shared/contracts/skills";
import type { AdapterContext, HarnessAdapter } from "./session-types";
import { object } from "./harness-transport";
import { plainToolText } from "./tool-events";

const configOption = z.object({
  id: z.string(),
  category: z.string().optional(),
  currentValue: z.string(),
  options: z.array(z.object({ value: z.string(), name: z.string() })).default([]),
});
export const acpSessionSchema = z.object({
  sessionId: nativeSessionIdSchema,
  configOptions: z.array(configOption).default([]),
  models: z
    .object({
      currentModelId: z.string(),
      availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })),
    })
    .optional(),
});
export const acpInitializationSchema = z.object({
  agentCapabilities: z.object({
    loadSession: z.boolean().optional(),
    sessionCapabilities: z.object({ delete: z.object({}).optional() }).optional(),
  }),
});
export const acpCommandsSchema = z.object({
  sessionId: nativeSessionIdSchema,
  update: z.object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(z.unknown()),
  }),
});
export const acpInitializeParams = {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "tidy_desktop", version: "0.1.0" },
};
const permission = z.object({
  sessionId: nativeSessionIdSchema,
  toolCall: z.object({ title: z.string().optional(), rawInput: z.unknown().optional() }),
  options: z.array(
    z.object({
      optionId: z.string(),
      kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
    }),
  ),
});
const visibleContent = z.object({ type: z.literal("text"), text: z.string() });
const toolUpdate = z.object({
  sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
  toolCallId: z.string().min(1).max(512),
  content: z.unknown().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
});
const updateSchema = z.object({
  sessionId: nativeSessionIdSchema,
  update: z.unknown(),
});
const supportedUpdate = z.discriminatedUnion("sessionUpdate", [
  z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: visibleContent }),
  z.object({ sessionUpdate: z.enum(["agent_thought_chunk", "plan"]) }),
  toolUpdate,
  z.object({
    sessionUpdate: z.literal("usage_update"),
    cost: z.object({ amount: z.number().nonnegative(), currency: z.string() }).nullish(),
  }),
]);
const promptResponse = z.object({
  stopReason: z.string(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      thoughtTokens: z.number().int().nonnegative().default(0),
      cachedReadTokens: z.number().int().nonnegative().default(0),
      cachedWriteTokens: z.number().int().nonnegative().default(0),
    })
    .optional(),
});
export function createOpenCodeAdapter(context: AdapterContext): HarnessAdapter {
  const { input, transport, emit } = context;
  let sessionId = input.sessionId;
  let messageId = "";
  let sessionCostUSD: number | undefined = input.sessionId ? undefined : 0;
  let costBaselineUSD: number | undefined;
  let costUSD: number | undefined;
  let initialized = false;
  const tools = new Map<
    string,
    { title: string; kind: "read" | "edit" | "search" | "command" | "tool" }
  >();
  let session: Promise<void> | undefined;
  const ensureSession = () =>
    (session ??= (async () => {
      const session = acpSessionSchema.parse({
        ...(sessionId ? { sessionId } : {}),
        ...object(
          await transport.request(sessionId ? "session/load" : "session/new", {
            cwd: input.cwd,
            mcpServers: [],
            ...(sessionId ? { sessionId } : {}),
          }),
        ),
      });
      sessionId = session.sessionId;
      emit({ type: "session", id: sessionId });
      if (input.settings?.model) {
        if (session.configOptions.some((option) => option.id === "model"))
          await transport.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: input.settings.model,
          });
        else
          await transport.request("session/set_model", {
            sessionId,
            modelId: input.settings.model,
          });
      }
      if (input.settings?.effort) {
        const option = session.configOptions.find((option) => option.category === "thought_level");
        if (!option) throw new Error("This OpenCode model does not expose reasoning effort.");
        await transport.request("session/set_config_option", {
          sessionId,
          configId: option.id,
          value: input.settings.effort,
        });
      }
      const model =
        input.settings?.model ??
        session.configOptions.find((option) => option.id === "model")?.currentValue ??
        session.models?.currentModelId;
      if (model) emit({ type: "model", model });
      initialized = true;
    })());
  return {
    async initialize() {
      const capabilities = acpInitializationSchema.parse(
        await transport.request("initialize", acpInitializeParams),
      );
      if (sessionId && !capabilities.agentCapabilities.loadSession)
        throw new Error("Update OpenCode to resume this conversation.");
      if (sessionId) await ensureSession();
    },
    async submit(message) {
      await ensureSession();
      costBaselineUSD = sessionCostUSD;
      costUSD = undefined;
      tools.clear();
      messageId = crypto.randomUUID();
      const prompt =
        message.skill?.invocation.kind === "command"
          ? `/${message.skill.invocation.name}${message.skill.prompt.slice(skillCommand(message.skill.prompt)?.end ?? 0)}\n\n${message.skill.context}`
          : message.prompt;
      context.submitting();
      const completion = transport.request(
        "session/prompt",
        {
          sessionId,
          prompt: [
            { type: "text", text: prompt },
            ...(message.images ?? []).map((image) => ({
              type: "image",
              mimeType: image.mimeType,
              data: image.data,
            })),
          ],
        },
        0,
      );
      // ACP acknowledges completion rather than prompt acceptance; progress confirms acceptance.
      void completion
        .then((result) => {
          const { usage } = promptResponse.parse(result);
          if (usage)
            emit({
              type: "usage",
              cumulative: false,
              usage: {
                inputTokens: usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens,
                cachedInputTokens: usage.cachedReadTokens,
                outputTokens: usage.outputTokens + usage.thoughtTokens,
                costUSD,
              },
            });
          tools.clear();
          context.complete();
        })
        .catch((error: unknown) =>
          context.complete(
            error instanceof Error ? error : new Error("OpenCode could not complete this turn."),
          ),
        );
    },
    consume(message) {
      if (message.method === "session/request_permission" && message.id !== undefined) {
        const request = permission.parse(message.params);
        if (!context.isActive() || request.sessionId !== sessionId) {
          transport.respond(message.id, { outcome: { outcome: "cancelled" } });
          return;
        }
        const choices: ApprovalDecision[] = [];
        const options = new Map<ApprovalDecision, string>();
        for (const option of request.options) {
          const decision =
            option.kind === "allow_once"
              ? "allow"
              : option.kind === "allow_always"
                ? "allow-session"
                : "deny";
          if (!options.has(decision)) {
            options.set(decision, option.optionId);
            choices.push(decision);
          }
        }
        context.ask(
          message.id,
          request.toolCall.title ?? "Allow tool?",
          "",
          request.toolCall.rawInput,
          choices,
          (decision) => ({
            outcome: options.has(decision)
              ? { outcome: "selected", optionId: options.get(decision) }
              : { outcome: "cancelled" },
          }),
        );
        return;
      }
      if (message.id !== undefined) {
        transport.reject(message.id, "This client capability is not available.");
        return;
      }
      if (message.method !== "session/update") return;
      const notification = updateSchema.parse(message.params);
      if (notification.sessionId !== sessionId) return;
      const parsed = supportedUpdate.safeParse(notification.update);
      if (!parsed.success) return;
      const update = parsed.data;
      if (update.sessionUpdate === "usage_update" && update.cost) {
        sessionCostUSD = update.cost.currency === "USD" ? update.cost.amount : undefined;
        if (initialized && context.isActive())
          costUSD =
            sessionCostUSD !== undefined &&
            costBaselineUSD !== undefined &&
            sessionCostUSD >= costBaselineUSD
              ? sessionCostUSD - costBaselineUSD
              : undefined;
      }
      if (!initialized) return;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        context.activity({
          id: update.toolCallId,
          state:
            update.status === "completed" || update.status === "failed"
              ? "finished"
              : update.status === "in_progress" ||
                  update.status === "pending" ||
                  update.sessionUpdate === "tool_call"
                ? "started"
                : "progress",
        });
      } else context.activity();
      if (!context.isActive()) return;
      if (
        [
          "agent_message_chunk",
          "agent_thought_chunk",
          "tool_call",
          "tool_call_update",
          "plan",
        ].includes(update.sessionUpdate)
      )
        context.accepted();
      if (update.sessionUpdate === "agent_message_chunk") {
        emit({ type: "message", id: messageId, text: update.content.text, append: true });
      } else if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        if (!update.toolCallId || update.kind === "think") return;
        const previous = tools.get(update.toolCallId);
        const kind =
          update.kind === "read"
            ? "read"
            : update.kind === "edit" || update.kind === "delete" || update.kind === "move"
              ? "edit"
              : update.kind === "search"
                ? "search"
                : update.kind === "execute"
                  ? "command"
                  : (previous?.kind ?? "tool");
        const title = plainToolText(update.title ?? previous?.title ?? "Tool").slice(0, 240);
        if (!previous && tools.size >= 1000) return;
        tools.set(update.toolCallId, { title, kind });
        const content = z
          .array(z.object({ type: z.string(), content: z.unknown().optional() }))
          .safeParse(update.content);
        const output = content.success
          ? content.data
              .flatMap((block) => {
                const parsed = visibleContent.safeParse(block.content);
                return parsed.success ? [parsed.data.text] : [];
              })
              .join("\n")
          : undefined;
        emit({
          type: "tool",
          tool: {
            id: update.toolCallId,
            title,
            kind,
            toolName: title.slice(0, 120),
            status:
              update.status === "completed"
                ? "completed"
                : update.status === "failed"
                  ? "failed"
                  : "running",
            ...(output ? { output: plainToolText(output).slice(0, 16000) } : {}),
          },
        });
      }
    },
    async interrupt() {
      transport.notify("session/cancel", { sessionId });
    },
  };
}
