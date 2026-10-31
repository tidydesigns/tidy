import { providerFailureKind } from "./provider-failure";
import type { HarnessFailureKind } from "../../shared/contracts/harness-failure";
import type { SkillInvocation } from "./harness-skills";
import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
export { startInteractiveHarness as startHarness } from "./interactive-harness";
import type { ApprovalRequest, ApprovalDecision } from "../../shared/contracts/permissions";
import { createToolEventParser } from "./tool-events";
import type { ToolActivityUpdate } from "../../shared/contracts/tool-activity";
import type { TokenUsage } from "../../shared/contracts/harness-settings";
import {
  harnessIdSchema,
  type HarnessConnection,
  type HarnessId,
} from "../../shared/contracts/desktop";
import { harnessNames as names } from "../../shared/contracts/harness-updates";

const execute = promisify(execFile);
export type HarnessUpdate =
  | { type: "activity"; activity: "Thinking" | "Working" }
  | { type: "started" }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string }
  | { type: "tool"; tool: ToolActivityUpdate }
  | { type: "usage"; usage: TokenUsage; cumulative: boolean }
  | { type: "model"; model: string }
  | { type: "session"; id: string }
  | { type: "message"; id: string; text: string; append?: boolean }
  | { type: "error"; text: string; kind?: HarnessFailureKind }
  | { type: "error-cleared"; text: string };
export type RunningHarness = {
  readonly deliveryState?: "not-submitted" | "unknown" | "accepted" | "rejected";
  done: Promise<void>;
  stop(): void;
  steer?(input: {
    prompt: string;
    skill?: { invocation: SkillInvocation; context: string; prompt: string };
    images: Array<{ path: string; mimeType: string; data: string }>;
  }): Promise<boolean>;
  respondToApproval?(id: string, decision: ApprovalDecision): boolean;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export const harnessEnvironmentKeys = [
  "HOME",
  "USERPROFILE",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "XDG_CACHE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;
export const additionalProviderEnvironmentKeys = [
  "OPENCODE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** Build the CLI environment from an allowlist and include standard user installation paths. */
export function harnessEnvironment(harness?: HarnessId): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    ...harnessEnvironmentKeys,
    ...(harness === "opencode" ? additionalProviderEnvironmentKeys : []),
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.PATH = [
    ...new Set([
      ...(process.env.PATH ?? "").split(delimiter),
      join(homedir(), ".local/bin"),
      join(homedir(), ".bun/bin"),
      join(homedir(), ".opencode/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ]
    .filter((directory) => isAbsolute(directory))
    .join(delimiter);
  environment.NO_COLOR = "1";
  return environment;
}

export async function findExecutable(id: string, environment = harnessEnvironment()) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null;
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (!isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const path = join(directory, `${id}${extension}`);
      try {
        await access(path, constants.X_OK);
        if (!(await stat(path)).isFile()) continue;
        return await realpath(path);
      } catch {
        /* Try the next executable location. */
      }
    }
  }
  return null;
}

export function findHarness(id: HarnessId, environment = harnessEnvironment()) {
  return findExecutable(id, environment);
}

export async function checkHarnesses(): Promise<HarnessConnection[]> {
  return Promise.all(
    harnessIdSchema.options.map(async (id) => {
      const executable = await findHarness(id);
      if (!executable) return { id, name: names[id], status: "not-installed" };
      try {
        const result = await execute(
          executable,
          id === "codex"
            ? ["login", "status"]
            : id === "claude"
              ? ["auth", "status", "--json"]
              : ["--version"],
          { env: harnessEnvironment(id), timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true },
        );
        if (id === "claude" && record(JSON.parse(result.stdout)).loggedIn === false)
          throw new Error("Sign in required.");
        return { id, name: names[id], status: "ready" };
      } catch {
        return { id, name: names[id], status: "signed-out" };
      }
    }),
  );
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
function readUsage(value: Record<string, unknown>): TokenUsage | undefined {
  if (!Object.keys(value).length) return;
  const cached = count(value.cache_read_input_tokens);
  return {
    inputTokens: count(value.input_tokens) + cached + count(value.cache_creation_input_tokens),
    cachedInputTokens: cached,
    outputTokens: count(value.output_tokens),
  };
}

/** Normalize only visible messages and tool progress, never reasoning or credentials. */
export function createClaudeParser(emit: (event: HarnessUpdate) => void) {
  let claudeMessageId = "response";
  let reported: Extract<HarnessUpdate, { type: "error" }> | undefined;
  let refused = false;
  const tools = createToolEventParser("claude", (tool) => emit({ type: "tool", tool }));
  return (input: unknown) => {
    const value = record(input);
    if (value.type !== "assistant" || value.parent_tool_use_id) tools(value);
    if (value.type === "system" && typeof value.model === "string")
      emit({ type: "model", model: value.model });
    if (typeof value.session_id === "string") emit({ type: "session", id: value.session_id });
    if (value.parent_tool_use_id) return;
    if (value.type === "rate_limit_event" && record(value.rate_limit_info).status === "rejected") {
      reported = {
        type: "error",
        text: "The provider usage limit was reached.",
        kind: "rate-limit",
      };
      emit(reported);
    }
    if (value.type === "system" && value.subtype === "model_refusal_no_fallback") {
      refused = true;
      reported = {
        type: "error",
        text:
          text(value.api_refusal_explanation) ||
          text(value.content) ||
          "The provider refused this request.",
        kind: "policy",
      };
      emit(reported);
    }
    if (
      value.type === "system" &&
      value.subtype === "model_refusal_fallback" &&
      value.scope !== "local"
    ) {
      if (reported) emit({ type: "error-cleared", text: reported.text });
      refused = false;
      reported = undefined;
    }
    const event = record(value.event);
    if (value.type === "stream_event") {
      if (event.type === "content_block_start" && record(event.content_block).type === "thinking")
        emit({ type: "activity", activity: "Thinking" });
      if (event.type === "message_start") {
        emit({ type: "activity", activity: "Working" });
        claudeMessageId = text(record(event.message).id) || "response";
      }
      const delta = record(event.delta);
      if (delta.type === "text_delta")
        emit({ type: "message", id: claudeMessageId, text: text(delta.text), append: true });
    }
    if (value.type === "assistant") {
      const message = record(value.message);
      claudeMessageId = text(message.id) || claudeMessageId;
      const content = Array.isArray(message.content) ? message.content.map(record) : [];
      const visible = content
        .filter((block) => block.type === "text")
        .map((block) => text(block.text))
        .join("\n");
      if (value.error) {
        const message = visible || text(value.error) || "Claude Code could not complete this turn.";
        reported = {
          type: "error",
          text: message,
          kind: providerFailureKind(message, text(value.error)),
        };
        emit(reported);
        return;
      }
      if (visible)
        emit({ type: "message", id: text(message.id) || claudeMessageId, text: visible });
      tools(value);
    }
    if (value.type === "result") {
      const failed =
        Boolean(value.is_error) ||
        text(value.subtype).startsWith("error_") ||
        value.stop_reason === "refusal" ||
        refused;
      const byModel = Object.values(record(value.modelUsage)).map(record);
      let usage: TokenUsage | undefined;
      if (byModel.length)
        usage = byModel.reduce<TokenUsage>(
          (total, model) => ({
            inputTokens:
              total.inputTokens +
              count(model.inputTokens) +
              count(model.cacheReadInputTokens) +
              count(model.cacheCreationInputTokens),
            cachedInputTokens: total.cachedInputTokens + count(model.cacheReadInputTokens),
            outputTokens: total.outputTokens + count(model.outputTokens),
          }),
          { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        );
      else usage = readUsage(record(value.usage));
      // Startup errors can report zeroed accounting even when resuming a used session.
      if (failed && usage && usage.inputTokens === 0 && usage.outputTokens === 0) usage = undefined;
      if (usage) {
        if (
          typeof value.total_cost_usd === "number" &&
          Number.isFinite(value.total_cost_usd) &&
          value.total_cost_usd >= 0
        )
          usage.costUSD = value.total_cost_usd;
        emit({ type: "usage", usage, cumulative: byModel.length > 0 });
      }
      if (failed) {
        const message =
          text(value.result) ||
          (Array.isArray(value.errors) ? value.errors.map(text).filter(Boolean).join("\n") : "") ||
          reported?.text ||
          "Claude Code could not complete this turn.";
        const subtypeKind = providerFailureKind("", text(value.subtype));
        const terminalKind = providerFailureKind("", text(value.terminal_reason));
        const inferredKind = providerFailureKind(message, "");
        const kind =
          value.stop_reason === "refusal" || refused
            ? "policy"
            : ([subtypeKind, terminalKind, inferredKind, reported?.kind ?? "unknown"].find(
                (kind) => kind !== "unknown",
              ) ?? "unknown");
        emit({ type: "error", text: message, kind });
      } else {
        if (reported) emit({ type: "error-cleared", text: reported.text });
        reported = undefined;
        if (text(value.result))
          emit({ type: "message", id: claudeMessageId, text: text(value.result) });
      }
    }
  };
}
